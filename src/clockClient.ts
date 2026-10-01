import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { ClockTimer } from './timers'
import type { ClockAlarm } from './alarms'
import { isSoundId, type AlarmSoundId } from './soundLibrary'
import type { SwState } from './stopwatch'
import type { ClockSnapshot } from './backend/clockOwner'
import type { PomoConfig, PomodoroProfile } from './pomodoro'

interface ClockClientPorts {
  api(): ValleyPluginApi
  enqueue(write: () => Promise<unknown>): void
  id(): string
  notify(): void
  timerSound(): { stop(): void; readonly continuous?: boolean } | null
  alarmSound(id: AlarmSoundId): { stop(): void; readonly continuous?: boolean } | null
}

export function createClockClient(ports: ClockClientPorts) {
  let current: ClockSnapshot = { session: '', revision: -1, stopwatch: { revision: -1, state: { running: false, startedAt: 0, elapsed: 0, laps: [] } }, timers: [], alarms: [], ringing: [], pomo: { state: { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: 1500000 }, profiles: [], profileId: 'focus', config: { work: 25, short: 5, long: 15, cycles: 4 } } }
  let base = current
  let serial = 0
  let refreshPending: Promise<void> | undefined
  let generation = 0
  let offs: Array<() => void> = []
  let showingError = false
  const reportError = (message: string) => {
    if (showingError) return
    showingError = true
    void ports.api().ui.confirm({ title: ports.api().ui.t('clock.error.title'), message, actions: [{ label: ports.api().ui.t('clock.error.dismiss'), value: 'dismiss' }] }).finally(() => { showingError = false })
  }
  const overlays = new Map<number, (snapshot: ClockSnapshot) => void>()
  const stoppedTimers = new Set<string>()
  const stoppedAlarms = new Set<string>()
  const timerSounds = new Map<string, { stop(): void; readonly continuous?: boolean }>()
  const alarmSounds = new Map<string, { stop(): void; readonly continuous?: boolean }>()
  const render = () => {
    const profiles = current.pomo.profiles
    current = structuredClone(base)
    for (const apply of overlays.values()) apply(current)
    if (JSON.stringify(profiles) === JSON.stringify(current.pomo.profiles)) current.pomo.profiles = profiles
    ports.notify()
  }
  const accept = (value: ClockSnapshot) => {
    if (!value || typeof value.session !== 'string' || !Number.isInteger(value.revision) || !Array.isArray(value.timers) || !Array.isArray(value.alarms) || !Array.isArray(value.ringing)) throw new Error('Invalid Clock state.')
    if (value.session === base.session && value.revision < base.revision) return
    base = structuredClone(value)
    render()
  }
  const stopSound = (sounds: Map<string, { stop(): void }>, id: string) => { sounds.get(id)?.stop(); sounds.delete(id) }
  const stopSounds = () => { for (const id of timerSounds.keys()) stopSound(timerSounds, id); for (const id of alarmSounds.keys()) stopSound(alarmSounds, id) }
  const refresh = (): Promise<void> => refreshPending ??= (async () => {
    const observed = generation
    const snapshot = await ports.api().backend.call<ClockSnapshot>('clock.snapshot')
    if (observed === generation) accept(snapshot)
  })().finally(() => { refreshPending = undefined })
  const send = (method: string, args: unknown[], apply: (state: ClockSnapshot) => void, guard?: { expectedSession: string; expectedRevision: number }) => {
    const token = ++serial
    const observed = generation
    const api = ports.api()
    overlays.set(token, apply)
    render()
    ports.enqueue(async () => {
      try {
        const result = await api.backend.call<{ snapshot: ClockSnapshot }>('clock.mutate', { method, args, ...guard })
        if (observed !== generation) return
        overlays.delete(token)
        accept(result.snapshot)
      } catch (error) {
        overlays.delete(token)
        render()
        if (observed === generation) reportError(error instanceof Error ? error.message : String(error))
        throw error
      }
    })
  }
  const stopwatchElapsed = (): number => current.stopwatch.state.elapsed + (current.stopwatch.state.running ? Math.max(0, Date.now() - current.stopwatch.state.startedAt) : 0)
  const changeStopwatch = (method: string, next: SwState): void => {
    if (!current.session) return
    const guard = { expectedSession: current.session, expectedRevision: current.stopwatch.revision }
    const stopwatch = { state: structuredClone(next), revision: guard.expectedRevision + 1 }
    send(method, [], state => { state.stopwatch = structuredClone(stopwatch) }, guard)
  }
  const timer = (id?: string) => id ? current.timers.find(value => value.id === id) : current.timers.at(-1)
  const alarm = (id: string) => current.alarms.find(value => value.id === id)
  const timerRemaining = (value: ClockTimer) => value.running ? Math.max(0, value.endsAt - Date.now()) : value.remaining
  const reorder = (kind: 'timers' | 'alarms', from: number, to: number) => {
    const items = current[kind]
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false
    const order = items.map(item => item.id)
    order.splice(to, 0, order.splice(from, 1)[0])
    send(kind === 'timers' ? 'timer.move' : 'alarm.move', [undefined, from, to], state => {
      const values = state[kind]
      values.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    })
    return true
  }
  const defaultSound = (): AlarmSoundId => {
    const value = ports.api().settings.get().alarmSound
    return isSoundId(value) ? value : 'beep'
  }
  const suspend = () => { stopSounds() }
  return {
    refresh,
    reset: () => { generation++; overlays.clear(); refreshPending = undefined; stopSounds() },
    listen: () => {
      offs.forEach(off => off())
      const observed = generation
      offs = [ports.api().backend.on('clock.state', payload => { if (observed === generation) accept(payload as ClockSnapshot) }), ports.api().backend.on('clock.error', payload => {
        if (observed === generation) reportError(String((payload as { message?: string })?.message ?? 'Clock could not save this change.'))
      })]
      void refresh().catch(() => {})
      const registered = offs
      return () => { registered.forEach(off => off()); if (offs === registered) { offs = []; generation++; overlays.clear(); refreshPending = undefined; suspend() } }
    },
    stopwatch: {
      get state() { return current.stopwatch.state },
      ready: () => Boolean(current.session),
      elapsed: stopwatchElapsed,
      load: refresh, resumeLoading: refresh, suspend: () => {},
      start: () => { if (!current.stopwatch.state.running) changeStopwatch('stopwatch.start', { ...current.stopwatch.state, running: true, startedAt: Date.now() }) },
      stop: () => { if (current.stopwatch.state.running) changeStopwatch('stopwatch.stop', { ...current.stopwatch.state, running: false, elapsed: stopwatchElapsed(), startedAt: 0 }) },
      lap: () => { if (current.stopwatch.state.running) changeStopwatch('stopwatch.lap', { ...current.stopwatch.state, laps: [stopwatchElapsed(), ...current.stopwatch.state.laps] }) },
      reset: () => changeStopwatch('stopwatch.reset', { running: false, startedAt: 0, elapsed: 0, laps: [] })
    },
    pomodoro: {
      get state() { return current.pomo.state },
      get profiles() { return current.pomo.profiles },
      get profileId() { return current.pomo.profileId },
      config: () => current.pomo.config,
      remaining: () => current.pomo.state.running ? Math.max(0, current.pomo.state.endsAt - Date.now()) : current.pomo.state.remaining,
      load: refresh, resumeLoading: refresh, suspend, ring: () => {},
      start: () => send('pomo.start', [], () => {}), pause: () => send('pomo.pause', [], () => {}), reset: () => send('pomo.reset', [], () => {}), skip: () => send('pomo.skip', [], () => {}),
      selectProfile: (id: string) => send('pomo.select', [id], () => {}),
      addProfile: (name?: string): PomodoroProfile => { const profile = { id: ports.id(), name: name ?? '', ...current.pomo.config }; send('pomo.add', [profile.id, name], () => {}); return profile },
      renameProfile: (id: string, name: string, commit = false) => send('pomo.rename', [id, name, commit], state => { const profile = state.pomo.profiles.find(profile => profile.id === id); if (profile) profile.name = commit ? name.trim() : name }),
      moveProfile: (from: number, to: number) => { send('pomo.move', [undefined, from, to], () => {}); return true },
      removeProfile: (id: string) => send('pomo.remove', [id], () => {}),
      updateProfile: (id: string, patch: Partial<PomoConfig>) => send('pomo.update', [id, patch], () => {})
    },
    timers: {
      get items() { return current.timers },
      load: (_order: readonly string[]) => refresh(),
      resumeLoading: () => refresh(),
      suspend,
      remaining: timerRemaining,
      stopSounds: () => { for (const id of timerSounds.keys()) stopSound(timerSounds, id) },
      stop: (id: string) => { stoppedTimers.add(id); stopSound(timerSounds, id) },
      ring: (id: string, _tick: number) => {
        const value = timer(id)
        if (!value || stoppedTimers.has(id) || (value.running ? value.endsAt > Date.now() : value.remaining > 0)) return
        value.running = false
        value.remaining = 0
        ports.notify()
        if (!timerSounds.get(id)?.continuous) {
          stopSound(timerSounds, id)
          const sound = ports.timerSound()
          if (sound) timerSounds.set(id, sound)
        }
      },
      add: (seconds: number, label = ''): ClockTimer | null => {
        const duration = Math.round(seconds * 1000)
        if (!Number.isFinite(duration) || duration <= 0 || duration > (999 * 3600 + 3599) * 1000 || label.length > 40) return null
        const value: ClockTimer = { id: ports.id(), duration, label: label.trim(), endsAt: Date.now() + duration, remaining: duration, running: true }
        send('timer.add', [value.id, seconds, value.label], state => { if (!state.timers.some(item => item.id === value.id)) state.timers.push({ ...value }) })
        return value
      },
      pause: (id?: string) => {
        const value = timer(id)
        if (!value?.running) return false
        const remaining = timerRemaining(value)
        send('timer.pause', [value.id], state => { const item = state.timers.find(item => item.id === value.id); if (item) Object.assign(item, { running: false, remaining }) })
        stopSound(timerSounds, value.id)
        return true
      },
      resume: (id?: string) => {
        const value = timer(id)
        if (!value || value.running || value.remaining <= 0) return false
        const endsAt = Date.now() + value.remaining
        stoppedTimers.delete(value.id)
        send('timer.resume', [value.id], state => { const item = state.timers.find(item => item.id === value.id); if (item) Object.assign(item, { running: true, endsAt }) })
        return true
      },
      cancel: (id?: string) => {
        const value = timer(id)
        if (!value) return false
        stopSound(timerSounds, value.id)
        send('timer.cancel', [value.id], state => { state.timers = state.timers.filter(item => item.id !== value.id) })
        return true
      },
      update: (id: string, patch: { label?: string; duration?: number }): ClockTimer | null => {
        const value = timer(id)
        if (!value || (patch.duration !== undefined && (value.running || !Number.isFinite(patch.duration) || patch.duration <= 0)) || (patch.label !== undefined && patch.label.length > 40)) return null
        const next = { ...value, ...patch, ...(patch.duration === undefined ? {} : { remaining: patch.duration, endsAt: 0 }) }
        send('timer.update', [id, patch], state => { const index = state.timers.findIndex(item => item.id === id); if (index >= 0) state.timers[index] = { ...state.timers[index], ...patch, ...(patch.duration === undefined ? {} : { remaining: patch.duration, endsAt: 0 }) } })
        return next
      },
      move: (from: number, to: number) => reorder('timers', from, to)
    },
    alarms: {
      get items() { return current.alarms },
      get ringing() { return current.ringing },
      defaultSound,
      load: (_order: readonly string[]) => refresh(),
      resumeLoading: () => refresh(),
      suspend,
      stopSounds: () => { for (const id of alarmSounds.keys()) stopSound(alarmSounds, id) },
      add: (init: Partial<ClockAlarm> = {}): ClockAlarm => {
        const now = new Date()
        const value: ClockAlarm = { hour: now.getHours(), minute: now.getMinutes(), label: '', days: [], sound: defaultSound(), enabled: true, ...init, id: init.id || ports.id() }
        send('alarm.add', [value.id, init], state => { if (!state.alarms.some(item => item.id === value.id)) state.alarms.push(structuredClone(value)) })
        return value
      },
      update: (id: string, patch: Partial<ClockAlarm>): ClockAlarm | null => {
        const value = alarm(id)
        if (!value) return null
        const next = { ...value, ...patch, id, snoozedUntil: undefined }
        if (next.days.length) next.date = undefined
        stopSound(alarmSounds, id)
        send('alarm.update', [id, patch], state => { const index = state.alarms.findIndex(item => item.id === id); if (index >= 0) state.alarms[index] = structuredClone(next); state.ringing = state.ringing.filter(item => item !== id) })
        return next
      },
      remove: (id: string): ClockAlarm | null => {
        const value = alarm(id)
        if (!value) return null
        stopSound(alarmSounds, id)
        send('alarm.remove', [id], state => { state.alarms = state.alarms.filter(item => item.id !== id); state.ringing = state.ringing.filter(item => item !== id) })
        return value
      },
      move: (from: number, to: number) => reorder('alarms', from, to),
      toggle: (id: string, on?: boolean) => {
        const value = alarm(id)
        if (!value) return false
        const enabled = on ?? !value.enabled
        stopSound(alarmSounds, id)
        send('alarm.toggle', [id, enabled], state => { const item = state.alarms.find(item => item.id === id); if (item) Object.assign(item, { enabled, snoozedUntil: undefined }); state.ringing = state.ringing.filter(item => item !== id) })
        return enabled
      },
      ring: (id: string, tick: number) => {
        const value = alarm(id)
        if (!value || (tick > 1 && stoppedAlarms.has(id))) return
        if (tick <= 1) stoppedAlarms.delete(id)
        if (!current.ringing.includes(id)) current.ringing.push(id)
        if (tick <= 1 && !value.days.length) value.enabled = false
        ports.notify()
        if (!alarmSounds.get(id)?.continuous) {
          stopSound(alarmSounds, id)
          const sound = ports.alarmSound(value.sound)
          if (sound) alarmSounds.set(id, sound)
        }
      },
      dismiss: (id: string) => { stoppedAlarms.add(id); stopSound(alarmSounds, id); send('alarm.dismiss', [id], state => { state.ringing = state.ringing.filter(value => value !== id) }) },
      snooze: (id: string) => { stoppedAlarms.add(id); stopSound(alarmSounds, id); send('alarm.snooze', [id], state => { state.ringing = state.ringing.filter(value => value !== id) }) },
      action: (id: string, action: string) => { if (action === 'stop' || action === 'snooze') { stoppedAlarms.add(id); stopSound(alarmSounds, id) } }
    }
  }
}
