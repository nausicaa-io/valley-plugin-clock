import type { PluginBackendApi } from '@valley/plugin-sdk'
import { createStopwatch, type SwState } from '../stopwatch'
import { createTimers, fmtCountdown, type ClockTimer, type TimerRunState } from '../timers'
import { createAlarms, type ClockAlarm } from '../alarms'
import { readStringList } from '../preferences'
import { isSoundId } from '../soundLibrary'
import { createPomodoro, type PomoState, type PomoConfig, type PomodoroProfile } from '../pomodoro'

export interface ClockSnapshot {
  session: string
  revision: number
  timers: ClockTimer[]
  alarms: ClockAlarm[]
  ringing: string[]
  stopwatch: { revision: number; state: SwState }
  pomo: { state: PomoState; profiles: PomodoroProfile[]; profileId: string; config: PomoConfig }
}

type OperationApi = Pick<PluginBackendApi, 'data' | 'settings' | 'notifications' | 'services'> & { rpc: Pick<PluginBackendApi['rpc'], 'emit'> }
export type ClockMutation = { method: string; args: unknown[]; expectedSession?: string; expectedRevision?: number }
const maximumSeconds = 999 * 3600 + 3599
const label = (value: unknown) => {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 40) throw new Error('A timer name can contain at most 40 characters.')
  return value
}
const identifier = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid Clock item id.')
  return value
}

const timerRunState = (value: unknown): TimerRunState => {
  const record = value as Partial<TimerRunState> | null
  const time = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!record || typeof record !== 'object' || typeof record.running !== 'boolean' || !time(record.endsAt) || !time(record.remaining) || (record.originReceipt !== undefined && typeof record.originReceipt !== 'string')) throw new Error('Invalid timer state.')
  return { running: record.running, endsAt: record.endsAt!, remaining: record.remaining!, ...(record.originReceipt === undefined ? {} : { originReceipt: record.originReceipt }) }
}

const timerRecord = (value: unknown): ClockTimer => {
  const record = value as Partial<ClockTimer> | null
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.label !== 'string' || typeof record.duration !== 'number' || !Number.isFinite(record.duration)) throw new Error('Invalid timer.')
  return { id: record.id, label: record.label, duration: record.duration, ...timerRunState(record) }
}

const pomoState = (value: unknown): PomoState => {
  const record = value as Partial<PomoState> | null
  const time = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!record || typeof record !== 'object' || !['work', 'short', 'long'].includes(record.phase as string) || !Number.isSafeInteger(record.cycle) || (record.cycle as number) < 0 || typeof record.running !== 'boolean' || !time(record.endsAt) || !time(record.remaining)) throw new Error('Invalid Pomodoro state.')
  return { phase: record.phase as PomoState['phase'], cycle: record.cycle as number, running: record.running, endsAt: record.endsAt as number, remaining: record.remaining as number }
}

const alarmKeys = ['id', 'hour', 'minute', 'label', 'days', 'date', 'sound', 'enabled', 'originReceipt', 'snoozedUntil'] as const
const alarmRecord = (value: unknown): ClockAlarm | null => {
  if (value === null) return null
  const record = value as Partial<ClockAlarm>
  const optional = (n: unknown, valid: (n: unknown) => boolean) => n === undefined || valid(n)
  if (!record || typeof record !== 'object' || typeof identifier(record.id) !== 'string' || !Number.isInteger(record.hour) || (record.hour as number) < 0 || (record.hour as number) > 23 || !Number.isInteger(record.minute) || (record.minute as number) < 0 || (record.minute as number) > 59
    || typeof record.label !== 'string' || !Array.isArray(record.days) || record.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !isSoundId(record.sound) || typeof record.enabled !== 'boolean'
    || !optional(record.date, n => typeof n === 'string') || !optional(record.originReceipt, n => typeof n === 'string') || !optional(record.snoozedUntil, n => typeof n === 'number' && Number.isFinite(n))) throw new Error('Invalid alarm.')
  // Keep the saved key order so a restored record serializes to the same bytes.
  return Object.fromEntries(Object.keys(record).filter(key => (alarmKeys as readonly string[]).includes(key)).map(key => [key, key === 'days' ? [...record.days!] : record[key as keyof ClockAlarm]])) as unknown as ClockAlarm
}
const conflict = (subject: string) => Object.assign(new Error(`${subject} changed; read its current state before editing.`), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })

const stopwatchState = (value: unknown): SwState => {
  const record = value as Partial<SwState> | null
  const time = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!record || typeof record !== 'object' || typeof record.running !== 'boolean' || !time(record.startedAt) || !time(record.elapsed) || !Array.isArray(record.laps) || !record.laps.every(time) || record.running !== (record.startedAt as number) > 0) throw new Error('Invalid stopwatch state.')
  return { running: record.running, startedAt: record.startedAt as number, elapsed: record.elapsed as number, laps: [...record.laps] as number[] }
}

export function createClockOwner(api: PluginBackendApi) {
  let active = true
  let revision = 0
  let stopwatchRevision = 0
  const session = `clock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let sequence = 0
  let operationApi: OperationApi = api
  let pending: Promise<unknown> = Promise.resolve()
  let writes: Array<() => Promise<unknown>> = []
  let notifications: Array<() => Promise<unknown>> = []
  let seen: string[] = []
  let effectAttempted = false
  const id = () => `clock-${Date.now().toString(36)}-${sequence++}-${Math.random().toString(36).slice(2, 8)}`
  const notify = () => {}
  const enqueue = (write: () => Promise<unknown>) => { writes.push(write) }
  const queuedNotifications = {
    schedule: (...args: Parameters<PluginBackendApi['notifications']['schedule']>) => { const scoped = operationApi; notifications.push(async () => { if (!await scoped.notifications.schedule(...args)) throw new Error('Could not schedule the Clock notification.') }); return Promise.resolve(true) },
    cancel: (...args: Parameters<PluginBackendApi['notifications']['cancel']>) => { const scoped = operationApi; notifications.push(() => scoped.notifications.cancel(...args)); return Promise.resolve(true) },
    stopRing: (...args: Parameters<PluginBackendApi['notifications']['stopRing']>) => { const scoped = operationApi; notifications.push(() => scoped.notifications.stopRing(...args)); return Promise.resolve(true) },
    snooze: (...args: Parameters<PluginBackendApi['notifications']['snooze']>) => { const scoped = operationApi; notifications.push(() => scoped.notifications.snooze(...args)); return Promise.resolve(true) }
  }
  const rootModelApi = { data: api.data, settings: api.settings, notifications: queuedNotifications }
  let modelApi = rootModelApi
  const models = () => ({
    stopwatch: createStopwatch({ api: () => modelApi, enqueue, now: () => Date.now(), notify }),
    pomodoro: createPomodoro({ api: () => modelApi, enqueue, now: Date.now, id, notify, sound: () => null, title: () => api.i18n.t('auto.212e4618d030'), phaseName: phase => api.i18n.t(phase === 'work' ? 'auto.fe7f55b8bf68' : phase === 'short' ? 'auto.19e173199148' : 'auto.03485170c086'), persistenceError: () => new Error('Could not save Clock settings.') }),
    timers: createTimers({ api: () => modelApi, enqueue, now: Date.now, id, notify, sound: () => null, title: () => api.i18n.t('auto.9d9cec22f36f'), formatDuration: fmtCountdown, persistenceError: () => new Error('Could not save Clock settings.') }),
    alarms: createAlarms({ api: () => modelApi, enqueue, now: Date.now, id, notify, removed: () => {}, sound: () => null, title: () => api.i18n.t('auto.25f8c55de811'), persistenceError: () => new Error('Could not save Clock settings.') })
  })
  let { timers, alarms, pomodoro, stopwatch } = models()
  const snapshot = (): ClockSnapshot => structuredClone({ session, revision, timers: timers.items, alarms: alarms.items, ringing: alarms.ringing, stopwatch: { revision: stopwatchRevision, state: stopwatch.state }, pomo: { state: pomodoro.state, profiles: pomodoro.profiles, profileId: pomodoro.profileId, config: pomodoro.config() } })
  const publish = () => { revision++; operationApi.rpc.emit('clock.state', snapshot()) }
  const hostRing = async (request: () => Promise<boolean>) => {
    effectAttempted = true
    effectAttempted = await request()
    return effectAttempted
  }
  const flush = async () => {
    while (writes.length) { effectAttempted = true; await writes.shift()!() }
    while (notifications.length) { effectAttempted = true; await notifications.shift()!() }
  }
  const load = async () => {
    await Promise.all([stopwatch.load(), pomodoro.load(), timers.load(readStringList(api.settings.get().timerOrder) ?? []), alarms.load(readStringList(api.settings.get().alarmOrder) ?? [])])
    await flush()
  }
  const ready = (async () => {
    const ledger = await api.data.files.readText('workflow-occurrences.json')
    if (ledger !== null) {
      const parsed: unknown = JSON.parse(ledger)
      if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) throw new Error('Invalid Clock occurrence history.')
      seen = parsed.slice(-256)
    }
    await load()
    publish()
  })()
  void ready.catch(error => api.rpc.emit('clock.error', { message: error instanceof Error ? error.message : String(error) }))
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.catch(() => {}).then(async () => {
      await ready
      if (!active) throw new Error('Clock service is stopped.')
      effectAttempted = false
      try { return await operation() } catch (error) {
        const uncertain = effectAttempted
        if (!uncertain && writes.length === 0 && notifications.length === 0) throw error
        stopwatchRevision++
        operationApi = api
        modelApi = rootModelApi
        writes = []; notifications = []
        ;({ timers, alarms, pomodoro, stopwatch } = models())
        try { await load(); publish() } catch (recoveryError) {
          api.rpc.emit('clock.error', { message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) })
        }
        throw uncertain ? Object.assign(new Error(error instanceof Error ? error.message : String(error)), { outcomeUnknown: true }) : error
      } finally { operationApi = api; modelApi = rootModelApi }
    })
    pending = next
    return next
  }
  const mutate = (request: ClockMutation, originReceipt?: string, scoped: OperationApi = api, cancellation?: AbortSignal) => serialize(async () => {
    cancellation?.throwIfAborted()
    if (request.method.startsWith('stopwatch.') && (request.expectedSession !== session || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== stopwatchRevision)) throw Object.assign(new Error('Stopwatch changed; read its current state before editing.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    operationApi = scoped
    modelApi = { data: scoped.data, settings: scoped.settings, notifications: queuedNotifications }
    const args = Array.isArray(request.args) ? request.args : []
    const itemId = identifier(args[0])
    let value: unknown
    switch (request.method) {
      case 'stopwatch.start': stopwatch.start(); value = true; break
      case 'stopwatch.stop': stopwatch.stop(); value = true; break
      case 'stopwatch.lap': if (!stopwatch.state.running) throw new Error('Start the stopwatch before recording a lap.'); stopwatch.lap(); value = true; break
      case 'stopwatch.reset': stopwatch.reset(); value = true; break
      case 'stopwatch.restore': stopwatch.restore(stopwatchState(args[1])); value = true; break
      case 'timer.add': {
        const seconds = args[1]
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > maximumSeconds) throw new Error('Timer duration must be between one second and 999:59:59.')
        if (itemId && timers.items.some(timer => timer.id === itemId)) throw new Error('This timer already exists.')
        value = timers.add(seconds, label(args[2]), { id: itemId, originReceipt })
        break
      }
      case 'timer.pause': value = timers.pause(itemId); break
      case 'timer.resume': {
        const timer = itemId ? timers.items.find(item => item.id === itemId) : timers.items.at(-1)
        if (timer && !timer.running && timer.remaining > 0 && originReceipt) timer.originReceipt = originReceipt
        value = timers.resume(itemId); break
      }
      case 'timer.restore': {
        if (!itemId || !timers.restore(itemId, timerRunState(args[1]), timerRunState(args[2]))) throw Object.assign(new Error('Timer changed; read its current state before editing.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
        value = true
        break
      }
      case 'timer.discard': {
        const expected = timerRecord(args[1])
        if (!itemId || expected.id !== itemId || !timers.discard(itemId, expected)) throw conflict('Timer')
        value = true
        break
      }
      case 'timer.cancel': value = timers.cancel(itemId); break
      case 'timer.stop': {
        value = timers.items.some(timer => timer.id === itemId) && await hostRing(() => scoped.notifications.stopRing(`timer:${itemId}`))
        if (value) timers.stop(itemId ?? '')
        break
      }
      case 'timer.update': {
        const patch = args[1] as { label?: unknown; duration?: unknown }
        if (!patch || typeof patch !== 'object') throw new Error('Expected timer values.')
        if (patch.duration !== undefined && (typeof patch.duration !== 'number' || !Number.isFinite(patch.duration) || patch.duration <= 0 || patch.duration > maximumSeconds * 1000)) throw new Error('Invalid timer duration.')
        value = timers.update(itemId ?? '', { ...(patch.label === undefined ? {} : { label: label(patch.label) }), ...(patch.duration === undefined ? {} : { duration: patch.duration as number }) })
        break
      }
      case 'timer.move': value = timers.move(Number(args[1]), Number(args[2])); break
      case 'alarm.add':
      case 'alarm.update': {
        const values = args[1] as Partial<ClockAlarm> | undefined
        if (!values || typeof values !== 'object') throw new Error('Expected alarm values.')
        if ((values.hour !== undefined && (!Number.isInteger(values.hour) || values.hour < 0 || values.hour > 23)) || (values.minute !== undefined && (!Number.isInteger(values.minute) || values.minute < 0 || values.minute > 59))) throw new Error('Invalid alarm time.')
        if (values.days !== undefined && (!Array.isArray(values.days) || values.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('Invalid alarm weekdays.')
        if (values.sound !== undefined && !isSoundId(values.sound)) throw new Error('Invalid alarm sound.')
        if (values.date !== undefined && values.date && (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || !Number.isFinite(Date.parse(`${values.date}T12:00:00Z`)) || new Date(`${values.date}T12:00:00Z`).toISOString().slice(0, 10) !== values.date)) throw new Error('Invalid alarm date.')
        if (values.label !== undefined && typeof values.label !== 'string') throw new Error('Expected an alarm name.')
        const safe = { ...values, ...(values.label === undefined ? {} : { label: values.label.trim() }) }
        delete safe.id
        delete safe.originReceipt
        if (request.method === 'alarm.add') {
          if (itemId && alarms.items.some(alarm => alarm.id === itemId)) throw new Error('This alarm already exists.')
          value = alarms.add(safe, { id: itemId, originReceipt })
        } else value = alarms.update(itemId ?? '', safe)
        break
      }
      case 'alarm.remove': value = alarms.remove(itemId ?? ''); break
      case 'alarm.restore': {
        const expected = alarmRecord(args[1])
        const next = alarmRecord(args[2])
        const index = args[3] === undefined ? undefined : Number(args[3])
        if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) throw new Error('Invalid alarm position.')
        if (!itemId || (!expected && !next) || (expected && expected.id !== itemId) || (next && next.id !== itemId) || !alarms.restore(itemId, expected, next, index)) throw conflict('Alarm')
        value = true
        break
      }
      case 'alarm.toggle': {
        if (args[1] !== undefined && typeof args[1] !== 'boolean') throw new Error('Expected an alarm enabled flag.')
        const alarm = alarms.items.find(item => item.id === itemId)
        if (alarm && originReceipt) alarm.originReceipt = originReceipt
        if (!alarm) value = null
        else { alarms.toggle(alarm.id, args[1] as boolean | undefined); value = { ...alarm } }
        break
      }
      case 'alarm.dismiss': {
        value = alarms.items.some(alarm => alarm.id === itemId) && (await hostRing(() => scoped.notifications.stopRing(`alarm:${itemId}`)) || alarms.ringing.includes(itemId ?? ''))
        if (value) alarms.action(itemId ?? '', 'stop')
        break
      }
      case 'alarm.snooze': {
        value = alarms.items.some(alarm => alarm.id === itemId) && await hostRing(() => scoped.notifications.snooze(`alarm:${itemId}`, alarms.snoozeMinutes()))
        if (value) alarms.action(itemId ?? '', 'snooze')
        break
      }
      case 'alarm.move': value = alarms.move(Number(args[1]), Number(args[2])); break
      case 'pomo.start': pomodoro.start(); break
      case 'pomo.pause': pomodoro.pause(); break
      case 'pomo.reset': pomodoro.reset(); break
      case 'pomo.skip': pomodoro.skip(); break
      case 'pomo.restore': if (!pomodoro.restore(pomoState(args[1]), pomoState(args[2]))) throw conflict('Pomodoro'); value = true; break
      case 'pomo.select': pomodoro.selectProfile(itemId ?? ''); break
      case 'pomo.add': value = pomodoro.addProfile(label(args[1]), itemId); break
      case 'pomo.rename': pomodoro.renameProfile(itemId ?? '', label(args[1]), args[2] === true); break
      case 'pomo.remove': pomodoro.removeProfile(itemId ?? ''); break
      case 'pomo.move': value = pomodoro.moveProfile(Number(args[1]), Number(args[2])); break
      case 'pomo.update': {
        const patch = args[1] as Record<string, unknown>
        if (!patch || typeof patch !== 'object' || Object.entries(patch).some(([key, value]) => !['work', 'short', 'long', 'cycles'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1440)) throw new Error('Invalid Pomodoro duration.')
        pomodoro.updateProfile(itemId ?? '', patch); break
      }
      default: throw new Error('Unknown Clock action.')
    }
    cancellation?.throwIfAborted()
    await flush()
    if (request.method.startsWith('stopwatch.')) stopwatchRevision++
    publish()
    return { value: structuredClone(value), snapshot: snapshot() }
  })
  const offOccurrence = api.notifications.onOccurrence(event => {
    if (!event.key.startsWith('timer:') && !event.key.startsWith('alarm:') && event.key !== 'pomodoro') return
    void serialize(async () => {
      if (seen.includes(event.occurrenceId)) return
      const timer = event.key.startsWith('timer:') ? timers.items.find(value => `timer:${value.id}` === event.key) : undefined
      const alarm = event.key.startsWith('alarm:') ? alarms.items.find(value => `alarm:${value.id}` === event.key) : undefined
      if (event.key === 'pomodoro') { pomodoro.ring(event.missed); await flush(); publish(); return }
      if (!timer && !alarm) return
      const accepted = timer ? timers.ring(timer.id, 1) : alarms.ring(alarm!.id, 1, event.scheduledAt)
      if (!accepted) return
      if (event.missed) { if (timer) timers.stop(timer.id); if (alarm) alarms.dismiss(alarm.id) }
      if (alarm?.enabled && alarm.days.length) alarms.refill(alarm.id)
      await flush()
      const history = [...seen, event.occurrenceId].slice(-256)
      const baseline = await api.data.files.readTextBaseline('workflow-occurrences.json')
      const saved = await api.data.files.writeTextGuarded('workflow-occurrences.json', `${JSON.stringify(history)}\n`, baseline?.baseline ?? null)
      if (!saved.ok) throw new Error('Could not save Clock occurrence history.')
      seen = history
      publish()
      if (!event.missed) await api.services.emit('workflow.provider', timer ? 'timer.finished' : 'alarm.fired', JSON.parse(JSON.stringify({ record: timer ?? alarm, occurrenceId: event.occurrenceId, scheduledAt: event.scheduledAt, firedAt: event.firedAt })), (timer ?? alarm)?.originReceipt ? { causation: (timer ?? alarm)!.originReceipt } : undefined)
    }).catch(error => api.rpc.emit('clock.error', { message: error instanceof Error ? error.message : String(error) }))
  })
  const offAction = api.notifications.onAction(event => {
    if (event.action !== 'stop' && event.action !== 'snooze') return
    void serialize(async () => {
      if (event.key.startsWith('timer:') && event.action === 'stop') timers.stop(event.key.slice(6))
      if (event.key.startsWith('alarm:')) alarms.action(event.key.slice(6), event.action as 'stop' | 'snooze')
      await flush(); publish()
    }).catch(error => api.rpc.emit('clock.error', { message: error instanceof Error ? error.message : String(error) }))
  })
  return { ready, snapshot: async () => { await ready; await pending.catch(() => {}); return snapshot() }, mutate, dispose: async () => { active = false; offOccurrence(); offAction(); await pending.catch(() => {}); timers.suspend(); alarms.suspend(); pomodoro.suspend(); stopwatch.suspend() } }
}
