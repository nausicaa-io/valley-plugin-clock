import type { DatasetRecord, ValleyPluginApi } from '@valley/plugin-sdk'

export interface ClockTimer {
  id: string
  label: string
  duration: number
  endsAt: number
  remaining: number
  running: boolean
}

interface TimerPorts {
  api(): Pick<ValleyPluginApi, 'data' | 'settings' | 'notifications'>
  enqueue(write: () => Promise<unknown>): void
  now(): number
  id(): string
  notify(): void
  sound(): { stop(): void } | null
  title(): string
  formatDuration(milliseconds: number): string
  persistenceError(): Error
}

export function createTimers(ports: TimerPorts) {
  let items: ClockTimer[] = []
  const sounds = new Map<string, { stop(): void }>()
  const stopped = new Set<string>()
  let loadGeneration = 0
  let loadPending = false
  let reloadNeeded = false
  let savedOrder: readonly string[] = []
  let active = true
  const touch = (): void => { loadGeneration++; loadPending = false; reloadNeeded = false }
  const key = (id: string): string => `timer:${id}`
  const find = (id?: string): ClockTimer | undefined => id ? items.find(timer => timer.id === id) : items.at(-1)
  const remaining = (timer: ClockTimer): number => timer.running ? Math.max(0, timer.endsAt - ports.now()) : timer.remaining
  const stopSound = (id: string): void => {
    sounds.get(id)?.stop()
    sounds.delete(id)
  }
  const stop = (id: string): void => {
    const timer = find(id)
    if (timer && (!timer.running || timer.endsAt <= ports.now())) { touch(); stopped.add(id) }
    stopSound(id)
  }
  const schedule = (timer: ClockTimer, api = ports.api()): void => {
    stopped.delete(timer.id)
    void api.notifications.schedule(key(timer.id), [timer.endsAt], {
      eventId: 'timer', title: timer.label.trim() || ports.title(), body: ports.formatDuration(timer.duration),
      ring: { actions: ['stop'] }
    })
  }
  const read = async (api: ReturnType<TimerPorts['api']>, current = (): boolean => true): Promise<DatasetRecord[]> => {
    const records: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      if (!current()) break
      const page = await api.data.dataset('timers').query({ limit: 1000, cursor })
      records.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return records
  }
  const persist = (): void => {
    const snapshot = items.map(timer => ({ ...timer }))
    const order = JSON.stringify(snapshot.map(timer => timer.id))
    const api = ports.api()
    ports.enqueue(async () => {
      const existing = await read(api)
      await api.data.dataset('timers').batch([
        ...existing.map(row => ({ operation: 'delete' as const, key: { id: String(row.id) } })),
        ...snapshot.map(values => ({ operation: 'insert' as const, values }))
      ])
      if (!(await api.settings.set('timerOrder', order)).ok) throw ports.persistenceError()
    })
  }
  const changed = (): void => { touch(); persist(); ports.notify() }
  const stopSounds = (): void => { for (const id of sounds.keys()) stopSound(id) }
  const load = async (order: readonly string[]): Promise<void> => {
    const requestedOrder = [...order]
    savedOrder = requestedOrder
    const generation = ++loadGeneration
    const api = ports.api()
    const current = (): boolean => active && generation === loadGeneration && api === ports.api()
    loadPending = true
    reloadNeeded = false
    try {
      const records = await read(api, current)
      if (!current()) return
      const now = ports.now()
      const restored: ClockTimer[] = records.flatMap(record => {
        if (typeof record.id !== 'string') return []
        const timer: ClockTimer = {
          id: record.id, label: typeof record.label === 'string' ? record.label : '',
          duration: Number(record.duration) || 0, endsAt: Number(record.endsAt) || 0,
          remaining: Number(record.remaining) || 0, running: !!record.running
        }
        if (timer.running) {
          if (timer.endsAt <= now) { timer.running = false; timer.remaining = 0 }
          else schedule(timer, api)
        }
        return [timer]
      })
      if (restored.length) {
        const byId = new Map(restored.map(timer => [timer.id, timer]))
        const ordered = requestedOrder.flatMap(id => {
          const timer = byId.get(id)
          if (!timer) return []
          byId.delete(id)
          return [timer]
        })
        items = [...ordered, ...byId.values()]
        ports.notify()
      }
    } catch (error) {
      if (current()) throw error
    } finally { if (generation === loadGeneration) loadPending = false }
  }
  return {
    get items(): ClockTimer[] { return items },
    remaining,
    stop,
    stopSounds,
    load,
    resumeLoading(): Promise<void> { active = true; return reloadNeeded ? load(savedOrder) : Promise.resolve() },
    suspend(): void { active = false; if (loadPending) reloadNeeded = true; loadPending = false; loadGeneration++; stopSounds() },
    ring(id: string, tick: number): void {
      const timer = find(id)
      if (!active || !timer || stopped.has(id) || (timer.running ? timer.endsAt > ports.now() : timer.remaining > 0)) return
      touch()
      timer.running = false
      timer.remaining = 0
      stopSound(id)
      const sound = ports.sound()
      if (sound) sounds.set(id, sound)
      if (tick <= 1) persist()
      ports.notify()
    },
    add(seconds: number, label?: string): ClockTimer | null {
      const duration = Math.round(seconds * 1000)
      if (!Number.isFinite(duration) || duration <= 0) return null
      const timer = { id: ports.id(), label: label?.trim() || '', duration, endsAt: ports.now() + duration, remaining: duration, running: true }
      items.push(timer)
      schedule(timer)
      changed()
      return timer
    },
    pause(id?: string): boolean {
      const timer = find(id)
      if (!timer?.running) return false
      timer.remaining = remaining(timer)
      timer.running = false
      stop(timer.id)
      void ports.api().notifications.cancel(key(timer.id))
      changed()
      return true
    },
    resume(id?: string): boolean {
      const timer = find(id)
      if (!timer || timer.running || timer.remaining <= 0) return false
      timer.endsAt = ports.now() + timer.remaining
      timer.running = true
      schedule(timer)
      changed()
      return true
    },
    cancel(id?: string): boolean {
      const timer = find(id)
      if (!timer) return false
      stopSound(timer.id)
      stopped.delete(timer.id)
      void ports.api().notifications.cancel(key(timer.id))
      items = items.filter(entry => entry.id !== timer.id)
      changed()
      return true
    },
    update(id: string, patch: { label?: string; duration?: number }): ClockTimer | null {
      const timer = find(id)
      if (!timer || (patch.duration !== undefined && (timer.running || !Number.isFinite(patch.duration) || patch.duration <= 0))) return null
      if (patch.label !== undefined) timer.label = patch.label
      if (patch.duration !== undefined) { timer.duration = patch.duration; timer.remaining = patch.duration; timer.endsAt = 0 }
      changed()
      return timer
    },
    move(from: number, to: number): boolean {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false
      const next = [...items]
      const [timer] = next.splice(from, 1)
      next.splice(to, 0, timer)
      items = next
      changed()
      return true
    }
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function fmtCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const hrs = Math.floor(total / 3600)
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Parse a human duration ("5m", "1h30m", "90s", "25") into seconds. A bare
 *  number is read as minutes. Returns 0 when nothing parses. */
export function parseDuration(raw: string): number {
  const s = raw.trim().toLowerCase()
  if (!s) return 0
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60
  let total = 0
  let matched = false
  for (const m of s.matchAll(/(\d+)\s*(h|m|s)/g)) {
    matched = true
    const n = parseInt(m[1], 10)
    total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n
  }
  return matched ? total : 0
}
