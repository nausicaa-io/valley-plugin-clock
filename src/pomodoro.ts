import { uiText } from './localization'
import type { ValleyPluginApi } from '@valley/plugin-sdk'

export type PomoPhase = 'work' | 'short' | 'long'
export interface PomoConfig { work: number; short: number; long: number; cycles: number }
export interface PomodoroProfile extends PomoConfig { id: string; name: string }
export interface PomoState { phase: PomoPhase; cycle: number; running: boolean; endsAt: number; remaining: number }

export function pomodoroNextPhase(phase: PomoPhase, cycle: number, cyclesBeforeLong: number): { phase: PomoPhase; cycle: number } {
  if (phase === 'work') {
    const next = cycle + 1
    return next >= Math.max(1, cyclesBeforeLong) ? { phase: 'long', cycle: 0 } : { phase: 'short', cycle: next }
  }
  return { phase: 'work', cycle }
}

interface PomodoroPorts {
  api(): Pick<ValleyPluginApi, 'data' | 'settings' | 'notifications'>
  enqueue(write: () => Promise<unknown>): void
  now(): number
  id(): string
  notify(): void
  sound(): { stop(): void } | null
  title(): string
  phaseName(phase: PomoPhase): string
  persistenceError(): Error
}

export function createPomodoro(ports: PomodoroPorts) {
  const profileNumber = (value: unknown, fallback: number): number => {
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  const defaults = (): PomoConfig => {
    const settings = ports.api().settings.get()
    return {
      work: profileNumber(settings.pomodoroWork, 25), short: profileNumber(settings.pomodoroShort, 5),
      long: profileNumber(settings.pomodoroLong, 15), cycles: profileNumber(settings.pomodoroCycles, 4)
    }
  }
  const readProfiles = (): PomodoroProfile[] => {
    const raw = ports.api().settings.get().pomodoroProfiles
    let parsed: unknown = raw
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw) } catch { parsed = null } }
    const fallback = defaults()
    if (!Array.isArray(parsed)) return [{ id: 'focus', name: '', ...fallback }]
    const profiles = parsed.flatMap((value, index): PomodoroProfile[] => {
      if (!value || typeof value !== 'object') return []
      const item = value as Partial<PomodoroProfile>
      return [{
        id: typeof item.id === 'string' && item.id.trim() ? item.id : `pomodoro-${index + 1}`,
        name: typeof item.name === 'string' ? item.name.trim() : '',
        work: profileNumber(item.work, fallback.work), short: profileNumber(item.short, fallback.short),
        long: profileNumber(item.long, fallback.long), cycles: Math.max(1, Math.round(profileNumber(item.cycles, fallback.cycles)))
      }]
    })
    return profiles.length ? profiles : [{ id: 'focus', name: '', ...fallback }]
  }
  let profiles = readProfiles()
  let selected = profiles.find(profile => profile.id === ports.api().settings.get().pomodoroActiveProfile) ?? profiles[0]
  const config = (): PomoConfig => ({ work: selected.work, short: selected.short, long: selected.long, cycles: selected.cycles })
  const phaseMs = (phase: PomoPhase): number => config()[phase] * 60_000
  let state: PomoState = { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: phaseMs('work') }
  let generation = 0
  let loading = false
  let reloadNeeded = false
  let active = true
  let sound: { stop(): void } | null = null
  const touch = (): void => { generation++; loading = false; reloadNeeded = false }
  const stopSound = (): void => { sound?.stop(); sound = null }
  const cancel = (): void => { stopSound(); void ports.api().notifications.cancel('pomodoro') }
  const remaining = (): number => state.running ? Math.max(0, state.endsAt - ports.now()) : state.remaining
  const persist = (): void => {
    const api = ports.api()
    const snapshot = { id: 'pomodoro', ...state }
    ports.enqueue(() => api.data.dataset('pomodoro_state').upsert(snapshot))
  }
  const persistProfiles = (mirror = false): void => {
    const api = ports.api()
    const serialized = JSON.stringify(profiles)
    const id = selected.id
    const values = config()
    ports.enqueue(async () => {
      if (mirror) {
        for (const [key, value] of Object.entries(values)) {
          const setting = `pomodoro${key[0].toUpperCase()}${key.slice(1)}`
          if (!(await api.settings.set(setting, value)).ok) throw ports.persistenceError()
        }
      }
      if (!(await api.settings.set('pomodoroProfiles', serialized)).ok) throw ports.persistenceError()
      if (!(await api.settings.set('pomodoroActiveProfile', id)).ok) throw ports.persistenceError()
    })
  }
  const schedule = (): void => {
    void ports.api().notifications.schedule('pomodoro', [state.endsAt], {
      eventId: 'pomodoro', title: ports.title(), body: ports.phaseName(pomodoroNextPhase(state.phase, state.cycle, config().cycles).phase)
    })
  }
  const reset = (): void => {
    touch()
    cancel()
    state = { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: phaseMs('work') }
    persist()
  }
  const load = async (): Promise<void> => {
    const api = ports.api()
    const revision = ++generation
    const current = (): boolean => active && api === ports.api() && revision === generation
    loading = true
    reloadNeeded = false
    try {
      const record = await api.data.dataset('pomodoro_state').get({ id: 'pomodoro' })
      if (!current() || !record) return
      const phase: PomoPhase = record.phase === 'short' || record.phase === 'long' ? record.phase : 'work'
      const savedEnd = Number(record.endsAt)
      const running = !!record.running && Number.isFinite(savedEnd) && savedEnd > ports.now()
      const savedRemaining = Number(record.remaining)
      const cycle = Number(record.cycle)
      state = {
        phase, cycle: Number.isFinite(cycle) ? Math.max(0, Math.floor(cycle)) : 0,
        running, endsAt: running ? savedEnd : 0,
        remaining: running ? Math.max(0, savedEnd - ports.now()) : record.running ? 0 : Number.isFinite(savedRemaining) ? Math.max(0, savedRemaining) : phaseMs(phase)
      }
      if (running) schedule()
      ports.notify()
    } catch (error) {
      if (current()) throw error
    } finally { if (revision === generation) loading = false }
  }
  return {
    get state(): PomoState { return state },
    get profiles(): PomodoroProfile[] { return profiles },
    get profileId(): string { return selected.id },
    config,
    remaining,
    load,
    suspend(): void { active = false; if (loading) reloadNeeded = true; loading = false; generation++; stopSound() },
    resumeLoading(): Promise<void> { active = true; return reloadNeeded ? load() : Promise.resolve() },
    selectProfile(id: string): void {
      const profile = profiles.find(entry => entry.id === id)
      if (!profile || profile.id === selected.id) return
      selected = profile
      reset()
      persistProfiles(true)
      ports.notify()
    },
    addProfile(name?: string): PomodoroProfile {
      const profile = { id: ports.id(), name: name?.trim() || `${ports.title()} ${profiles.length + 1}`, ...config() }
      profiles = [...profiles, profile]
      selected = profile
      reset()
      persistProfiles(true)
      ports.notify()
      return profile
    },
    renameProfile(id: string, name: string, commit = false): void {
      const profile = profiles.find(entry => entry.id === id)
      if (!profile) return
      const next = commit ? name.trim() : name
      if (next === profile.name) return
      profile.name = next
      persistProfiles()
      ports.notify()
    },
    moveProfile(from: number, to: number): boolean {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= profiles.length || to >= profiles.length || from === to) return false
      const next = [...profiles]
      const [profile] = next.splice(from, 1)
      next.splice(to, 0, profile)
      profiles = next
      persistProfiles()
      ports.notify()
      return true
    },
    removeProfile(id: string): void {
      if (profiles.length <= 1) return
      const next = profiles.filter(profile => profile.id !== id)
      if (next.length === profiles.length) return
      profiles = next
      const removedActive = id === selected.id
      if (removedActive) { selected = next[0]; reset() }
      persistProfiles(removedActive)
      ports.notify()
    },
    updateProfile(id: string, patch: Partial<PomoConfig>): void {
      const profile = profiles.find(entry => entry.id === id)
      if (!profile) return
      const next = {
        ...profile, work: profileNumber(patch.work, profile.work), short: profileNumber(patch.short, profile.short),
        long: profileNumber(patch.long, profile.long), cycles: Math.max(1, Math.round(profileNumber(patch.cycles, profile.cycles)))
      }
      profiles = profiles.map(entry => entry.id === id ? next : entry)
      const updatedActive = id === selected.id
      if (updatedActive) {
        selected = next
        if (!state.running) { touch(); state.remaining = phaseMs(state.phase); persist() }
      }
      persistProfiles(updatedActive)
      ports.notify()
    },
    ring(): void {
      if (!active || !state.running || state.endsAt > ports.now()) return
      touch()
      const next = pomodoroNextPhase(state.phase, state.cycle, config().cycles)
      state.phase = next.phase
      state.cycle = next.cycle
      state.remaining = phaseMs(next.phase)
      state.endsAt = ports.now() + state.remaining
      stopSound()
      sound = ports.sound()
      schedule()
      persist()
      ports.notify()
    },
    start(): void {
      if (state.running) return
      touch()
      if (state.remaining <= 0) state.remaining = phaseMs(state.phase)
      state.endsAt = ports.now() + state.remaining
      state.running = true
      schedule()
      persist()
      ports.notify()
    },
    pause(): void {
      if (!state.running) return
      touch()
      state.remaining = remaining()
      state.running = false
      cancel()
      persist()
      ports.notify()
    },
    reset(): void { reset(); ports.notify() },
    skip(): void {
      touch()
      stopSound()
      const next = pomodoroNextPhase(state.phase, state.cycle, config().cycles)
      state.phase = next.phase
      state.cycle = next.cycle
      state.remaining = phaseMs(next.phase)
      if (state.running) { state.endsAt = ports.now() + state.remaining; schedule() }
      persist()
      ports.notify()
    }
  }
}

/** Display name of a Pomodoro phase — the panel's readout and its notification. */
export function pomoPhaseName(phase: PomoPhase): string {
  if (phase === 'work') return uiText('auto.fe7f55b8bf68')
  return phase === 'short' ? uiText('auto.19e173199148') : uiText('auto.03485170c086')
}
