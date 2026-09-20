import { uiText } from './localization'
import type { DatasetRecord, DatasetTransactionOperation, ValleyPluginApi } from '@valley/plugin-sdk'
import { SOUNDS, type AlarmSoundId } from './sounds'

export interface ClockAlarm {
  id: string
  hour: number // 0–23, wall clock
  minute: number // 0–59
  label: string
  /** Weekdays it repeats on, 0 = Sunday … 6 = Saturday. Empty ⇒ one-shot. */
  days: number[]
  /** ISO `YYYY-MM-DD`; only meaningful for a one-shot (`days` empty). */
  date?: string
  sound: AlarmSoundId
  enabled: boolean
  /**
   * Epoch ms a snooze re-fires at. Persisted so a reload no longer forgets it —
   * snooze used to live in a `window.setTimeout` and died with the window,
   * which quietly turned "9 more minutes" into "never".
   */
  snoozedUntil?: number
}

/** Epoch ms of the next firing of `alarm` strictly after `now`, or `null` when
 *  it can never fire again (a disabled alarm, or a one-shot already past).
 *
 *  Recurring alarms scan the next 8 local days so a DST shift — which moves the
 *  wall-clock target by an hour without changing the weekday — still resolves,
 *  and the target is rebuilt with a local `Date` per candidate day so the result
 *  is the real wall-clock time in the user's zone, not a fixed 24 h stride. */
export function nextAlarmAt(alarm: ClockAlarm, now: Date): number | null {
  if (!alarm.enabled) return null
  const h = alarm.hour
  const m = alarm.minute
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null

  if (alarm.days.length === 0) {
    // One-shot: on an explicit date, else the next occurrence of that time.
    if (alarm.date) {
      const parts = alarm.date.split('-').map((n) => parseInt(n, 10))
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
      const at = new Date(parts[0], parts[1] - 1, parts[2], h, m, 0, 0).getTime()
      return at > now.getTime() ? at : null
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
    if (today.getTime() > now.getTime()) return today.getTime()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0)
    return tomorrow.getTime()
  }

  const wanted = new Set(alarm.days.filter((d) => d >= 0 && d <= 6))
  if (wanted.size === 0) return null
  for (let i = 0; i < 8; i += 1) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m, 0, 0)
    if (wanted.has(cand.getDay()) && cand.getTime() > now.getTime()) return cand.getTime()
  }
  return null
}

/**
 * The next `count` firings of `alarm`, ascending.
 *
 * The host schedules a **list of instants**, not a recurrence: weekday sets,
 * DST and one-shot semantics stay here, in the plugin that owns them, and core
 * only walks a sorted list of epoch ms. Handing over several at a time is what
 * lets an alarm keep firing while no window is open to top the list up — the
 * renderer re-fills it whenever it is alive.
 */
export function nextOccurrences(alarm: ClockAlarm, count = 8, from = new Date()): number[] {
  const out: number[] = []
  let cursor = from
  for (let i = 0; i < count; i += 1) {
    const at = nextAlarmAt(alarm, cursor)
    if (at == null) break
    out.push(at)
    // Step past this firing by a second: `nextAlarmAt` is strictly-after, so
    // seeding it with the firing itself would otherwise return the same instant.
    cursor = new Date(at + 1000)
    // A one-shot has exactly one firing; asking again would roll it to tomorrow.
    if (alarm.days.length === 0) break
  }
  return out
}

interface AlarmPorts {
  api(): Pick<ValleyPluginApi, 'data' | 'settings' | 'notifications'>
  enqueue(write: () => Promise<unknown>): void
  now(): number
  id(): string
  notify(): void
  removed(id: string): void
  sound(id: AlarmSoundId): { stop(): void } | null
  title(): string
  persistenceError(): Error
}

export function createAlarms(ports: AlarmPorts) {
  let items: ClockAlarm[] = []
  let ringing: string[] = []
  const sounds = new Map<string, { stop(): void }>()
  const armedAt = new Map<string, number>()
  let loadGeneration = 0
  let loadPending = false
  let reloadNeeded = false
  let savedOrder: readonly string[] = []
  const key = (id: string): string => `alarm:${id}`
  const find = (id: string): ClockAlarm | undefined => items.find(alarm => alarm.id === id)
  const stopSound = (id: string): void => { sounds.get(id)?.stop(); sounds.delete(id) }
  const stop = (id: string): void => { stopSound(id); ringing = ringing.filter(value => value !== id) }
  const read = async (api: ReturnType<AlarmPorts['api']>, dataset: string): Promise<DatasetRecord[]> => {
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await api.data.dataset(dataset).query({ limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }
  const persist = (): void => {
    const snapshot = items.map(alarm => ({ ...alarm, days: [...alarm.days] }))
    const order = JSON.stringify(snapshot.map(alarm => alarm.id))
    const api = ports.api()
    ports.enqueue(async () => {
      const existing = await read(api, 'alarms')
      const operations: DatasetTransactionOperation[] = [
        ...existing.map(row => ({ dataset: 'alarms', operation: 'delete' as const, key: { id: String(row.id) } })),
        ...snapshot.flatMap(alarm => [
          { dataset: 'alarms', operation: 'insert' as const, values: { id: alarm.id, hour: alarm.hour, minute: alarm.minute, label: alarm.label, date: alarm.date ?? null, sound: alarm.sound, enabled: alarm.enabled, snoozedUntil: alarm.snoozedUntil ?? null } },
          ...alarm.days.map(day => ({ dataset: 'alarm_days', operation: 'insert' as const, values: { alarmId: alarm.id, day } }))
        ])
      ]
      if (operations.length) await api.data.transaction(operations)
      if (!(await api.settings.set('alarmOrder', order)).ok) throw ports.persistenceError()
    })
  }
  const changed = (): void => { persist(); ports.notify() }
  const defaultSound = (): AlarmSoundId => {
    const sound = ports.api().settings.get().alarmSound
    return typeof sound === 'string' && Object.hasOwn(SOUNDS, sound) ? sound as AlarmSoundId : 'beep'
  }
  const snoozeMinutes = (): number => {
    const value = ports.api().settings.get().alarmSnooze
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 9
  }
  const cancel = (id: string): void => { armedAt.delete(id); void ports.api().notifications.cancel(key(id)) }
  const schedule = (alarm: ClockAlarm): void => {
    const now = ports.now()
    const occurrences = nextOccurrences(alarm, 8, new Date(now))
    if (alarm.snoozedUntil && alarm.snoozedUntil > now) occurrences.unshift(alarm.snoozedUntil)
    if (!occurrences.length) { cancel(alarm.id); return }
    armedAt.set(alarm.id, Math.min(...occurrences))
    void ports.api().notifications.schedule(key(alarm.id), occurrences, {
      eventId: 'alarm', title: alarm.label.trim() || ports.title(),
      body: `${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}`,
      ring: { actions: ['stop', 'snooze'], snoozeMinutes: snoozeMinutes() }
    })
  }
  const normalize = (value: Partial<ClockAlarm>): ClockAlarm => ({
    id: typeof value.id === 'string' && value.id ? value.id : ports.id(),
    hour: Math.min(23, Math.max(0, Math.floor(Number(value.hour) || 0))),
    minute: Math.min(59, Math.max(0, Math.floor(Number(value.minute) || 0))),
    label: typeof value.label === 'string' ? value.label : '',
    days: Array.isArray(value.days) ? [...new Set(value.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [],
    date: typeof value.date === 'string' && value.date ? value.date : undefined,
    sound: typeof value.sound === 'string' && Object.hasOwn(SOUNDS, value.sound) ? value.sound as AlarmSoundId : 'beep',
    enabled: value.enabled !== false,
    snoozedUntil: typeof value.snoozedUntil === 'number' && Number.isFinite(value.snoozedUntil) && value.snoozedUntil > ports.now() ? value.snoozedUntil : undefined
  })
  const recordSnooze = (alarm: ClockAlarm): void => {
    stop(alarm.id)
    if (!alarm.snoozedUntil || alarm.snoozedUntil <= ports.now()) alarm.snoozedUntil = ports.now() + snoozeMinutes() * 60_000
    armedAt.set(alarm.id, alarm.snoozedUntil)
    changed()
  }
  const load = async (order: readonly string[]): Promise<void> => {
    savedOrder = [...order]
    const generation = ++loadGeneration
    loadPending = true
    reloadNeeded = false
    const api = ports.api()
    try {
      const [records, days] = await Promise.all([read(api, 'alarms'), read(api, 'alarm_days')])
      if (api !== ports.api() || generation !== loadGeneration) return
      const daysByAlarm = new Map<string, number[]>()
      for (const row of days) {
        const id = String(row.alarmId)
        const values = daysByAlarm.get(id) ?? []
        values.push(Number(row.day)); daysByAlarm.set(id, values)
      }
      const restored = records.map(record => normalize({ ...record, days: daysByAlarm.get(String(record.id)) ?? [] } as unknown as Partial<ClockAlarm>))
      if (!restored.length) return
      const byId = new Map(restored.map(alarm => [alarm.id, alarm]))
      const ordered = order.flatMap(id => { const alarm = byId.get(id); byId.delete(id); return alarm ? [alarm] : [] })
      items = [...ordered, ...byId.values()]
      items.forEach(schedule)
      ports.notify()
    } catch (error) {
      if (api === ports.api() && generation === loadGeneration) throw error
    } finally { if (generation === loadGeneration) loadPending = false }
  }
  const stopSounds = (): void => { for (const id of sounds.keys()) stopSound(id) }
  return {
    get items(): ClockAlarm[] { return items },
    get ringing(): string[] { return ringing },
    defaultSound,
    stopSounds,
    load,
    resumeLoading(): Promise<void> { return reloadNeeded ? load(savedOrder) : Promise.resolve() },
    suspend(): void {
      if (loadPending) reloadNeeded = true
      loadPending = false
      loadGeneration++
      stopSounds()
    },
    add(init: Partial<ClockAlarm> = {}): ClockAlarm {
      const now = new Date(ports.now())
      const alarm = normalize({ hour: now.getHours(), minute: now.getMinutes(), sound: defaultSound(), ...init, id: undefined })
      items.push(alarm)
      schedule(alarm)
      changed()
      return alarm
    },
    update(id: string, patch: Partial<ClockAlarm>): ClockAlarm | null {
      const index = items.findIndex(alarm => alarm.id === id)
      if (index < 0) return null
      const next = normalize({ ...items[index], ...patch, id })
      if (next.days.length) next.date = undefined
      next.snoozedUntil = undefined
      items[index] = next
      stop(id)
      schedule(next)
      changed()
      return next
    },
    remove(id: string): ClockAlarm | null {
      const alarm = find(id)
      if (!alarm) return null
      cancel(id)
      stop(id)
      items = items.filter(alarm => alarm.id !== id)
      ports.removed(id)
      changed()
      return alarm
    },
    move(from: number, to: number): boolean {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false
      const next = [...items]
      next.splice(to, 0, next.splice(from, 1)[0])
      if (next.every((alarm, index) => alarm.id === items[index].id)) return false
      items = next
      changed()
      return true
    },
    toggle(id: string, on?: boolean): boolean {
      const alarm = find(id)
      if (!alarm) return false
      alarm.enabled = on ?? !alarm.enabled
      if (alarm.enabled && !alarm.days.length && alarm.date && nextAlarmAt(alarm, new Date(ports.now())) == null) alarm.date = undefined
      alarm.snoozedUntil = undefined
      stop(id)
      if (alarm.enabled) schedule(alarm)
      else cancel(id)
      changed()
      return alarm.enabled
    },
    ring(id: string, tick: number): void {
      const alarm = find(id)
      if (!alarm || (!ringing.includes(id) && (!armedAt.has(id) || armedAt.get(id)! > ports.now()))) return
      stopSound(id)
      const sound = ports.sound(alarm.sound)
      if (sound) sounds.set(id, sound)
      if (!ringing.includes(id)) ringing.push(id)
      if (tick <= 1) {
        armedAt.delete(id)
        alarm.snoozedUntil = undefined
        if (!alarm.days.length) alarm.enabled = false
        persist()
      }
      ports.notify()
    },
    dismiss(id: string): void {
      stop(id)
      void ports.api().notifications.stopRing(key(id))
      const alarm = find(id)
      if (alarm?.enabled) schedule(alarm)
      ports.notify()
    },
    snooze(id: string): void {
      const alarm = find(id)
      if (!alarm) return
      void ports.api().notifications.snooze(key(id), snoozeMinutes())
      recordSnooze(alarm)
    },
    action(id: string, action: string): void {
      if (action !== 'stop' && action !== 'snooze') return
      stop(id)
      const alarm = find(id)
      if (action === 'snooze' && alarm) recordSnooze(alarm)
      else { if (alarm?.enabled) schedule(alarm); ports.notify() }
    }
  }
}

/** Weekday index (0 = Sunday) for the app's lowercase week-start preference. */
export const WEEK_START_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

/** The seven weekday indices rotated so `weekStart` comes first. */
export function orderedWeekdays(weekStart: string): number[] {
  const first = WEEK_START_INDEX[weekStart] ?? 1
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7)
}

/** Human summary of an alarm's recurrence, e.g. "Every day", "Weekdays",
 *  "Mon Tue Fri", a one-shot's date, or "Once". Weekday names come from
 *  `dayNames` (locale-supplied, index 0 = Sunday) and are listed starting at
 *  the user's `weekStart`. */
export function repeatLabel(alarm: ClockAlarm, weekStart: string, dayNames: string[]): string {
  const days = [...new Set(alarm.days.filter((d) => d >= 0 && d <= 6))]
  if (days.length === 0) return alarm.date ? alarm.date : uiText('auto.d9c768782ea8')
  if (days.length === 7) return uiText('auto.3b2eb5131055')
  const set = new Set(days)
  const isWeekdays = [1, 2, 3, 4, 5].every((d) => set.has(d)) && !set.has(0) && !set.has(6)
  if (isWeekdays) return uiText('auto.4ffc67b62aae')
  const isWeekends = set.has(0) && set.has(6) && set.size === 2
  if (isWeekends) return uiText('auto.2f92a0aa8ae9')
  return orderedWeekdays(weekStart)
    .filter((d) => set.has(d))
    .map((d) => dayNames[d] ?? '')
    .join(' ')
}

/** Parse a wall-clock time ("07:30", "7.30", "0730", "7") into hour + minute.
 *  Returns `null` when nothing sensible parses or the value is out of range. */
export function parseClockTime(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim()
  if (!s) return null
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?$/.exec(s)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null
  return { hour, minute }
}

const DAY_TOKENS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
}
/** Parse a CLI repeat spec ("mon,wed,fri", "weekdays", "daily") into weekday
 *  indices (0 = Sunday). An unparseable token is ignored; `[]` ⇒ one-shot. */
export function parseDays(raw: string): number[] {
  const s = raw.trim().toLowerCase()
  if (!s) return []
  if (s === 'daily' || s === 'everyday' || s === 'every day') return [0, 1, 2, 3, 4, 5, 6]
  if (s === 'weekdays') return [1, 2, 3, 4, 5]
  if (s === 'weekends') return [0, 6]
  const out = new Set<number>()
  for (const token of s.split(/[\s,]+/)) {
    const d = DAY_TOKENS[token]
    if (d != null) out.add(d)
  }
  return [...out].sort()
}
