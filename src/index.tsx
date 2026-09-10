/**
 * Built-in **Clock** plugin — a right-sidebar panel with five tabs plus a footer
 * live-time item, all driveable from the command bus / CLI (`clock:*`).
 *
 *   • Clock      — the SBB white-faced analog clock (kept as-is) with an
 *                  Analog⇆Digital toggle, the local time/date, and the world
 *                  clock list underneath: pick famous cities from a dropdown,
 *                  each row shows the local time + a Today/Tomorrow day-offset
 *                  label and tints by its own day/night.
 *   • Alarm      — recurring or one-shot wall-clock alarms. Each row folds open
 *                  into an inline editor: time, label, a seven round day
 *                  buttons repeat picker (ordered from the user's week-start
 *                  preference), a date for one-shots, and a sound.
 *   • Stopwatch  — start / stop / lap / reset, analog chronograph or digital.
 *   • Timer      — **multiple** independent countdown timers, each with its own
 *                  alarm; analog depleting ring or digital.
 *   • Pomodoro   — configurable work / short-break / long-break cycles.
 *
 * Everything but the SVG geometry is styled from `styles.ts` with Valley
 * tokens — no inline font stacks, pixel type scales or capsule buttons.
 *
 * The whole engine lives in a `window`-anchored store (`__valleyClockStore`) with
 * a listener set, so the footer item + panel share one source of truth and a
 * running session (timers, pomodoro, stopwatch) survives the panel unmounting or
 * the plugin module being re-imported on hot reload. Alarms are module-managed
 * timeouts so they fire even when the panel is closed.
 *
 * It uses `api.React.createElement` and never imports `react`; no JSX runs at
 * module top level (the classic transform binds `React` only inside `register`).
 */
import type { PluginCommand, ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import type { DatasetRecord, DatasetTransactionOperation } from '@valley/plugin-sdk'
import { initLocalization } from './localization'
import { uiText } from './localization'
import { injectStyles } from './styles'
import { registerClockSurfaces } from './surfaces'

// ---- Palette ---------------------------------------------------------------
// Face + ink follow the theme: the disc inverts against the panel (white on a
// light theme — classic SBB — dark on a dark theme) while the marks/hands take
// the strongest foreground token so they stay crisp in both.
const FACE = 'var(--container-color-alt)'
const INK = 'var(--title-color)'
const DIAL_EDGE = 'var(--border-medium)'
const ACCENT = 'var(--accent-color)'

export type Mode = 'clock' | 'alarm' | 'stopwatch' | 'timer' | 'pomodoro'
type PomoPhase = 'work' | 'short' | 'long'

/** The five views a user can switch off, the way Assistant hides Telegram and
 *  WhatsApp: each one gates both its panel surface and its settings section
 *  (`visibleWhenSetting` in `config.json`). `world` lives inside the Clock tab
 *  rather than being a tab of its own, so the Clock tab itself never hides. */
export type ClockView = 'world' | 'alarm' | 'stopwatch' | 'timer' | 'pomodoro'
export const VIEW_SETTING: Record<ClockView, string> = {
  world: 'showWorld',
  alarm: 'showAlarm',
  stopwatch: 'showStopwatch',
  timer: 'showTimer',
  pomodoro: 'showPomodoro'
}
export const CLOCK_VIEWS = ['world', 'alarm', 'stopwatch', 'timer', 'pomodoro'] as const

/** All five default on, so an unwritten setting reads as enabled. */
export function viewEnabled(view: ClockView, settings: Readonly<Record<string, unknown>>): boolean {
  return settings[VIEW_SETTING[view]] !== false
}

/** The tabs that are switched on, in the plugin's canonical order. `clock` is
 *  always present and can never be hidden. */
export function visibleModes(settings: Readonly<Record<string, unknown>>): Mode[] {
  const tabs: Exclude<ClockView, 'world'>[] = ['alarm', 'stopwatch', 'timer', 'pomodoro']
  return ['clock', ...tabs.filter((v) => viewEnabled(v, settings))]
}

/** The tab strip as the user arranged it: saved tabs first in their stored
 *  order, then anything the saved order does not mention (a tab switched back
 *  on, or one a later version added) in canonical order. A stored id that is
 *  hidden or unknown is ignored rather than resurrecting a tab. */
export function orderedModes(visible: Mode[], saved: readonly string[]): Mode[] {
  const taken = new Set<string>()
  const out: Mode[] = []
  for (const id of saved) {
    if (!taken.has(id) && visible.includes(id as Mode)) {
      taken.add(id)
      out.push(id as Mode)
    }
  }
  for (const m of visible) if (!taken.has(m)) out.push(m)
  return out
}

/** Stopwatch state is two wall-clock numbers, never a tick count: `startedAt`
 *  is the epoch ms the current run began (0 while paused) and `elapsed` banks
 *  what earlier runs measured. See the stopwatch section of `createStore`. */
interface SwState {
  running: boolean
  startedAt: number // epoch ms (valid while running)
  elapsed: number // ms banked from previous runs
  laps: number[] // cumulative ms at each lap, newest first
}
export interface ClockTimer {
  id: string
  label: string
  duration: number // ms
  endsAt: number // epoch ms (valid while running)
  remaining: number // ms (valid while paused)
  running: boolean
}
/** Built-in synthesised alarm tones — no audio assets, so nothing to bundle. */
export type AlarmSoundId = 'beep' | 'chime' | 'pulse' | 'radar' | 'bell'
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
interface PomoConfig {
  work: number // minutes
  short: number
  long: number
  cycles: number // work sessions before a long break
}
export interface PomodoroProfile extends PomoConfig {
  id: string
  name: string
}
interface PomoState {
  phase: PomoPhase
  cycle: number // completed work sessions in the current set
  running: boolean
  endsAt: number
  remaining: number
}

// ---- Famous cities (curated; IANA time zones) ------------------------------
export interface City {
  id?: string
  name: string
  tz: string
  aliases?: string[]
}
export const CITIES: City[] = [
  { name: 'Honolulu', tz: 'Pacific/Honolulu' },
  { name: 'Anchorage', tz: 'America/Anchorage' },
  { name: 'Los Angeles', tz: 'America/Los_Angeles' },
  { id: 'America/Los_Angeles#San_Francisco', name: 'San Francisco', tz: 'America/Los_Angeles' },
  { id: 'America/Los_Angeles#Seattle', name: 'Seattle', tz: 'America/Los_Angeles' },
  { name: 'Vancouver', tz: 'America/Vancouver' },
  { name: 'Calgary', tz: 'America/Edmonton' },
  { name: 'Denver', tz: 'America/Denver' },
  { name: 'Phoenix', tz: 'America/Phoenix' },
  { name: 'Chicago', tz: 'America/Chicago' },
  { id: 'America/Chicago#Dallas', name: 'Dallas', tz: 'America/Chicago' },
  { name: 'New York', tz: 'America/New_York' },
  { id: 'America/New_York#Boston', name: 'Boston', tz: 'America/New_York' },
  { id: 'America/New_York#Miami', name: 'Miami', tz: 'America/New_York' },
  { id: 'America/New_York#Washington_DC', name: 'Washington, D.C.', tz: 'America/New_York', aliases: ['Washington DC'] },
  { name: 'Toronto', tz: 'America/Toronto' },
  { id: 'America/Toronto#Montreal', name: 'Montréal', tz: 'America/Toronto', aliases: ['Montreal'] },
  { name: 'Mexico City', tz: 'America/Mexico_City' },
  { id: 'America/Mexico_City#Guadalajara', name: 'Guadalajara', tz: 'America/Mexico_City' },
  { name: 'Havana', tz: 'America/Havana' },
  { name: 'Panama City', tz: 'America/Panama' },
  { name: 'San José', tz: 'America/Costa_Rica', aliases: ['San Jose'] },
  { name: 'San Juan', tz: 'America/Puerto_Rico' },
  { name: 'Bogotá', tz: 'America/Bogota', aliases: ['Bogota'] },
  { name: 'Lima', tz: 'America/Lima' },
  { name: 'Caracas', tz: 'America/Caracas' },
  { name: 'Santiago', tz: 'America/Santiago' },
  { name: 'São Paulo', tz: 'America/Sao_Paulo' },
  { id: 'America/Sao_Paulo#Rio_de_Janeiro', name: 'Rio de Janeiro', tz: 'America/Sao_Paulo' },
  { name: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires' },
  { name: 'Reykjavík', tz: 'Atlantic/Reykjavik', aliases: ['Reykjavik'] },
  { name: 'London', tz: 'Europe/London' },
  { name: 'Dublin', tz: 'Europe/Dublin' },
  { name: 'Lisbon', tz: 'Europe/Lisbon' },
  { name: 'Madrid', tz: 'Europe/Madrid' },
  { name: 'Paris', tz: 'Europe/Paris' },
  { name: 'Amsterdam', tz: 'Europe/Amsterdam' },
  { name: 'Brussels', tz: 'Europe/Brussels' },
  { id: 'Europe/Zurich#Bern', name: 'Bern', tz: 'Europe/Zurich', aliases: ['Berne'] },
  { name: 'Zürich', tz: 'Europe/Zurich', aliases: ['Zurich', 'Zuerich'] },
  { id: 'Europe/Zurich#Geneva', name: 'Geneva', tz: 'Europe/Zurich', aliases: ['Genève', 'Geneve'] },
  { name: 'Berlin', tz: 'Europe/Berlin' },
  { name: 'Copenhagen', tz: 'Europe/Copenhagen' },
  { name: 'Oslo', tz: 'Europe/Oslo' },
  { name: 'Stockholm', tz: 'Europe/Stockholm' },
  { name: 'Prague', tz: 'Europe/Prague' },
  { name: 'Budapest', tz: 'Europe/Budapest' },
  { name: 'Vienna', tz: 'Europe/Vienna' },
  { name: 'Warsaw', tz: 'Europe/Warsaw' },
  { name: 'Kyiv', tz: 'Europe/Kyiv', aliases: ['Kiev'] },
  { name: 'Rome', tz: 'Europe/Rome' },
  { name: 'Athens', tz: 'Europe/Athens' },
  { name: 'Bucharest', tz: 'Europe/Bucharest' },
  { name: 'Helsinki', tz: 'Europe/Helsinki' },
  { name: 'Istanbul', tz: 'Europe/Istanbul' },
  { name: 'Moscow', tz: 'Europe/Moscow' },
  { name: 'Casablanca', tz: 'Africa/Casablanca' },
  { name: 'Lagos', tz: 'Africa/Lagos' },
  { name: 'Accra', tz: 'Africa/Accra' },
  { name: 'Cairo', tz: 'Africa/Cairo' },
  { name: 'Johannesburg', tz: 'Africa/Johannesburg' },
  { id: 'Africa/Johannesburg#Cape_Town', name: 'Cape Town', tz: 'Africa/Johannesburg' },
  { name: 'Nairobi', tz: 'Africa/Nairobi' },
  { name: 'Addis Ababa', tz: 'Africa/Addis_Ababa' },
  { name: 'Jerusalem', tz: 'Asia/Jerusalem' },
  { id: 'Asia/Jerusalem#Tel_Aviv', name: 'Tel Aviv', tz: 'Asia/Jerusalem' },
  { name: 'Riyadh', tz: 'Asia/Riyadh' },
  { name: 'Dubai', tz: 'Asia/Dubai' },
  { id: 'Asia/Dubai#Abu_Dhabi', name: 'Abu Dhabi', tz: 'Asia/Dubai' },
  { name: 'Doha', tz: 'Asia/Qatar' },
  { name: 'Muscat', tz: 'Asia/Muscat' },
  { name: 'Tehran', tz: 'Asia/Tehran' },
  { name: 'Baku', tz: 'Asia/Baku' },
  { name: 'Tbilisi', tz: 'Asia/Tbilisi' },
  { name: 'Tashkent', tz: 'Asia/Tashkent' },
  { name: 'Almaty', tz: 'Asia/Almaty' },
  { name: 'Karachi', tz: 'Asia/Karachi' },
  { name: 'Mumbai', tz: 'Asia/Kolkata' },
  { id: 'Asia/Kolkata#New_Delhi', name: 'New Delhi', tz: 'Asia/Kolkata', aliases: ['Delhi'] },
  { id: 'Asia/Kolkata#Bengaluru', name: 'Bengaluru', tz: 'Asia/Kolkata', aliases: ['Bangalore'] },
  { name: 'Colombo', tz: 'Asia/Colombo' },
  { name: 'Kathmandu', tz: 'Asia/Kathmandu' },
  { name: 'Dhaka', tz: 'Asia/Dhaka' },
  { name: 'Bangkok', tz: 'Asia/Bangkok' },
  { name: 'Jakarta', tz: 'Asia/Jakarta' },
  { name: 'Kuala Lumpur', tz: 'Asia/Kuala_Lumpur' },
  { name: 'Ho Chi Minh City', tz: 'Asia/Ho_Chi_Minh', aliases: ['Saigon'] },
  { name: 'Singapore', tz: 'Asia/Singapore' },
  { name: 'Manila', tz: 'Asia/Manila' },
  { name: 'Hong Kong', tz: 'Asia/Hong_Kong' },
  { name: 'Shanghai', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Beijing', name: 'Beijing', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Shenzhen', name: 'Shenzhen', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Guangzhou', name: 'Guangzhou', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Chengdu', name: 'Chengdu', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Hangzhou', name: 'Hangzhou', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Wuhan', name: 'Wuhan', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Chongqing', name: 'Chongqing', tz: 'Asia/Shanghai' },
  { name: 'Macao', tz: 'Asia/Macau', aliases: ['Macau'] },
  { name: 'Taipei', tz: 'Asia/Taipei' },
  { id: 'Asia/Taipei#Kaohsiung', name: 'Kaohsiung', tz: 'Asia/Taipei' },
  { name: 'Tokyo', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Osaka', name: 'Osaka', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Kyoto', name: 'Kyoto', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Nagoya', name: 'Nagoya', tz: 'Asia/Tokyo' },
  { name: 'Seoul', tz: 'Asia/Seoul' },
  { id: 'Asia/Seoul#Busan', name: 'Busan', tz: 'Asia/Seoul' },
  { name: 'Perth', tz: 'Australia/Perth' },
  { name: 'Adelaide', tz: 'Australia/Adelaide' },
  { name: 'Brisbane', tz: 'Australia/Brisbane' },
  { name: 'Sydney', tz: 'Australia/Sydney' },
  { name: 'Melbourne', tz: 'Australia/Melbourne' },
  { name: 'Auckland', tz: 'Pacific/Auckland' },
  { id: 'Pacific/Auckland#Wellington', name: 'Wellington', tz: 'Pacific/Auckland' },
  { name: 'Suva', tz: 'Pacific/Fiji' },
  { name: 'Nouméa', tz: 'Pacific/Noumea', aliases: ['Noumea'] },
  { name: 'Guam', tz: 'Pacific/Guam' }
]
const cityId = (city: City): string => city.id ?? city.tz
const cityFor = (id: string): City | undefined => CITIES.find((city) => cityId(city) === id) ?? CITIES.find((city) => city.tz === id)
const cityZone = (id: string): string => cityFor(id)?.tz ?? id
const normalizeCityTerm = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const cityMatches = (city: City, query: string): boolean => {
  const q = normalizeCityTerm(query.trim())
  return q !== '' && [city.name, city.tz, ...(city.aliases ?? [])].some((value) => normalizeCityTerm(value).includes(q))
}
const cityName = (id: string): string => cityFor(id)?.name ?? id.split('/').pop()!.replace(/_/g, ' ')

// ---- Pure formatting / logic helpers (unit-tested) -------------------------
const pad = (n: number): string => String(n).padStart(2, '0')

export function fmtStopwatch(ms: number): string {
  const cs = Math.floor((ms % 1000) / 10)
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const hrs = Math.floor(ms / 3600000)
  const head = hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  return `${head}.${pad(cs)}`
}
export function fmtCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const hrs = Math.floor(total / 3600)
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Local wall-clock time in `tz` (24h), optionally with seconds. */
export function cityTime(tz: string, date: Date, seconds = false, locale = 'en-GB'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: cityZone(tz),
      hour: '2-digit',
      minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}),
      hour12: false
    }).format(date)
  } catch {
    return '--:--'
  }
}

/** Local hour (0–23) in `tz`, or -1 when the zone is invalid. */
export function cityHour(tz: string, date: Date): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: cityZone(tz), hour: '2-digit', hour12: false }).format(date)
    const n = parseInt(h, 10)
    return Number.isFinite(n) ? n % 24 : -1
  } catch {
    return -1
  }
}

/** Apple-Clock-style day/night flag: daytime is the 07:00–18:59 window in `tz`.
 *  A coarse fixed threshold (not true sunrise/sunset) — enough to tint a row
 *  light by day and dark at night. Invalid zones default to daytime. */
export function isDaytime(tz: string, date: Date): boolean {
  const h = cityHour(tz, date)
  if (h < 0) return true
  return h >= 7 && h < 19
}

/** Immutable array move: returns a copy of `list` with the item at `from`
 *  relocated to `to`. Out-of-range indices yield an unchanged copy. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** Whole-day offset of `tz` relative to the local day, as an Apple-style label
 *  ("Today" / "Tomorrow" / "Yesterday" / "+2 days"). */
export function dayOffsetLabel(tz: string, date: Date): string {
  const dayInTz = (d: Date, zone?: string): number => {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone ? cityZone(zone) : undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d)
    return Date.parse(`${s}T00:00:00Z`)
  }
  try {
    const here = dayInTz(date)
    const there = dayInTz(date, tz)
    const diff = Math.round((there - here) / 86400000)
    if (diff === 0) return uiText('auto.24345a14377f')
    if (diff === 1) return uiText('auto.1948bf2dfa8f')
    if (diff === -1) return uiText('auto.da24830f1f70')
    return diff > 0 ? uiText('auto.f36f7ec0d246', { p0: diff }) : uiText('auto.d9dd4edbc100', { p0: diff })
  } catch {
    return ''
  }
}

/** The next Pomodoro phase + cycle counter. After a work session, advance the
 *  cycle; every `cyclesBeforeLong` work sessions take a long break. */
export function pomodoroNextPhase(
  phase: PomoPhase,
  cycle: number,
  cyclesBeforeLong: number
): { phase: PomoPhase; cycle: number } {
  if (phase === 'work') {
    const next = cycle + 1
    return next >= Math.max(1, cyclesBeforeLong) ? { phase: 'long', cycle: 0 } : { phase: 'short', cycle: next }
  }
  return { phase: 'work', cycle }
}

/** Display name of a Pomodoro phase — the panel's readout and its notification. */
export function pomoPhaseName(phase: PomoPhase): string {
  if (phase === 'work') return uiText('auto.fe7f55b8bf68')
  return phase === 'short' ? uiText('auto.19e173199148') : uiText('auto.03485170c086')
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

/** A settings value written as a JSON array of strings (older installs, and
 *  hosts that keep the value typed, hand back the array itself). */
export function readStringList(raw: unknown): string[] | null {
  if (typeof raw === 'string') {
    try {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
    } catch {
      /* ignore */
    }
    return null
  }
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null
}

export const TIMER_PRESET_LIMIT = 5
export const DEFAULT_TIMER_PRESETS = ['1m', '3m', '5m', '10m', '25m']

/** Compact label for a preset duration — the form its chip and its quick button
 *  both wear ("90" → "1m30s", "3600" → "1h"). */
export function fmtPresetLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}`
}

/** The Timer tab's quick buttons. An unset list is the five fast defaults; a
 *  list the user emptied is honoured as "no quick buttons", so absence and `[]`
 *  must stay distinguishable — hence a stored JSON list, not a plain count. */
export function timerPresets(settings: Readonly<Record<string, unknown>>): string[] {
  const stored = readStringList(settings.timerPresets)
  const source = stored ?? DEFAULT_TIMER_PRESETS
  const out: string[] = []
  for (const raw of source) {
    const label = fmtPresetLabel(parseDuration(raw))
    if (label && !out.includes(label)) out.push(label)
    if (out.length === TIMER_PRESET_LIMIT) break
  }
  return out
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

export interface AnimState {
  mode: Mode
  swRunning: boolean
  anyTimerRunning: boolean
  pomoRunning: boolean
}
export function clockNeedsAnimation(s: AnimState, hidden: boolean): boolean {
  if (hidden) return false
  if (s.mode === 'stopwatch') return s.swRunning
  if (s.mode === 'timer') return s.anyTimerRunning
  if (s.mode === 'pomodoro') return s.pomoRunning
  if (s.mode === 'alarm') return false // a static list — never animate it
  return true // clock (+ world list): advance continuously
}

// ---- Audible alarms --------------------------------------------------------
// Tones are synthesised on the fly (WebAudio) rather than shipped as assets:
// `api.vault.readFile` is UTF-8 only, so a bundled sound file would need new
// SDK surface. `beep` is the historical timer/Pomodoro tone — keep it default.
interface SoundSpec {
  type: OscillatorType
  /** `[frequency Hz, duration s]` played back to back inside one repetition. */
  steps: [number, number][]
  repeat: number
  /** Silence between repetitions, in seconds. */
  gap: number
}
export const SOUNDS: Record<AlarmSoundId, SoundSpec> = {
  beep: { type: 'sine', steps: [[880, 0.3]], repeat: 4, gap: 0.42 },
  chime: {
    type: 'sine',
    steps: [
      [523, 0.35],
      [659, 0.35],
      [784, 0.5]
    ],
    repeat: 2,
    gap: 0.1
  },
  pulse: { type: 'square', steps: [[440, 0.12]], repeat: 8, gap: 0.18 },
  radar: {
    type: 'sawtooth',
    steps: [
      [600, 0.2],
      [900, 0.2]
    ],
    repeat: 3,
    gap: 0.25
  },
  bell: { type: 'triangle', steps: [[1046, 0.9]], repeat: 2, gap: 0.9 }
}
export const SOUND_IDS = Object.keys(SOUNDS) as AlarmSoundId[]

interface SoundPlayback {
  pause: () => void
  resume: () => void
  stop: () => void
}

function playSound(id: AlarmSoundId = 'beep', onDone?: () => void): SoundPlayback | null {
  const spec = SOUNDS[id] ?? SOUNDS.beep
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    // A square/sawtooth at the same gain reads much louder than a sine — trim
    // the harsher waveforms so no preset jumps out against the others.
    const peak = spec.type === 'sine' || spec.type === 'triangle' ? 0.3 : 0.18
    let t = ctx.currentTime
    const oscillators: OscillatorNode[] = []
    for (let r = 0; r < spec.repeat; r += 1) {
      for (const [freq, dur] of spec.steps) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = spec.type
        o.frequency.value = freq
        o.connect(g)
        g.connect(ctx.destination)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(peak, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, dur - 0.02))
        o.start(t)
        o.stop(t + dur)
        oscillators.push(o)
        t += dur
      }
      t += spec.gap
    }
    const totalMs = (t - ctx.currentTime) * 1000 + 200
    let closeTimer: number | null = null
    let remainingMs = totalMs
    let startedAt = Date.now()
    let paused = false
    let closed = false
    const finish = (notify: boolean): void => {
      if (closed) return
      closed = true
      if (closeTimer != null) window.clearTimeout(closeTimer)
      void ctx.close()
      if (notify) onDone?.()
    }
    const scheduleClose = (delay: number): void => {
      closeTimer = window.setTimeout(() => finish(true), delay)
    }
    scheduleClose(totalMs)
    return {
      pause: () => {
        if (closed || paused) return
        paused = true
        remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt))
        if (closeTimer != null) window.clearTimeout(closeTimer)
        closeTimer = null
        void ctx.suspend()
      },
      resume: () => {
        if (closed || !paused) return
        paused = false
        startedAt = Date.now()
        void ctx.resume()
        scheduleClose(remainingMs)
      },
      stop: () => {
        if (closed) return
        for (const oscillator of oscillators) {
          try { oscillator.stop() } catch { /* already stopped */ }
        }
        finish(false)
      }
    }
  } catch {
    /* audio unavailable — fail silently */
    return null
  }
}

// ---- Session-scoped store --------------------------------------------------
const STORE_KEY = 'clock.store'
let uid = 0
const genId = (): string => `t${Date.now().toString(36)}${(uid++).toString(36)}`

export interface ClockStore {
  ready: Promise<void>
  flush(): Promise<void>
  updateTimer(id: string, patch: { label?: string; duration?: number }): ClockTimer | null
  setApi(api: ValleyPluginApi): void
  subscribe(fn: () => void): () => void
  notify(): void
  state: {
    mode: Mode
    selectedTimer: string | null
    selectedCity: string | null
    sw: SwState
    timers: ClockTimer[]
    timerDrag: number | null
    timerDrop: { index: number; after: boolean } | null
    worldCities: string[]
    worldDrag: number | null
    worldDrop: { index: number; after: boolean } | null
    /** The tab strip's saved order (ids); empty means the canonical order. */
    tabOrder: string[]
    /** Index of the tab being dragged in the strip, if any. */
    tabDrag: number | null
    tabDrop: { index: number; after: boolean } | null
    pomoProfiles: PomodoroProfile[]
    pomoProfileId: string
    pomoSettingsProfileId: string | null
    pomoProfileDrag: number | null
    pomoProfileDrop: { index: number; after: boolean } | null
    pomo: PomoState
    pick: { h: number; m: number; s: number; label: string }
    alarms: ClockAlarm[]
    alarmDrag: number | null
    alarmDrop: { index: number; after: boolean } | null
    /** Id of the alarm whose inline editor is unfolded, if any. */
    alarmEditing: string | null
    /** Ids of alarms that have fired and are awaiting dismiss/snooze. */
    alarmRinging: string[]
  }
  pomoConfig(): PomoConfig
  pomoProfiles(): PomodoroProfile[]
  selectPomoProfile(id: string): void
  addPomoProfile(name?: string): PomodoroProfile
  renamePomoProfile(id: string, name: string, commit?: boolean): void
  pomoProfileMove(from: number, to: number): boolean
  removePomoProfile(id: string): void
  updatePomoProfile(id: string, patch: Partial<PomoConfig>): void
  /** Persisted display preference for a surface ('analog' default). Only the
   *  clock and the stopwatch have a face to choose — everything else is
   *  digital by design. */
  isDigital(surface: 'clock' | 'stopwatch'): boolean
  /** Re-render every subscriber to reflect changed plugin settings. */
  syncSettings(): void
  // actions
  setMode(m: Mode): void
  swStart(): void
  swStop(): void
  swLap(): void
  swReset(): void
  swElapsed(): number
  addTimer(seconds: number, label?: string): ClockTimer | null
  pauseTimer(id?: string): boolean
  resumeTimer(id?: string): boolean
  cancelTimer(id?: string): boolean
  timerRemaining(t: ClockTimer): number
  timerMove(from: number, to: number): boolean
  worldAdd(query: string): City | null
  worldRemove(tz: string): boolean
  worldMove(from: number, to: number): boolean
  /** Persist the tab strip's order after a drag. */
  setTabOrder(order: Mode[]): void
  defaultSound(): AlarmSoundId
  addAlarm(init?: Partial<ClockAlarm>): ClockAlarm
  updateAlarm(id: string, patch: Partial<ClockAlarm>): ClockAlarm | null
  removeAlarm(id: string): ClockAlarm | null
  alarmMove(from: number, to: number): boolean
  toggleAlarm(id: string, on?: boolean): boolean
  dismissAlarm(id: string): void
  snoozeAlarm(id: string): void
  setAlarmEditing(id: string | null): void
  pomoStart(): void
  pomoPause(): void
  pomoReset(): void
  pomoSkip(): void
  pomoRemaining(): number
  /**
   * Attach to the host's notification stream — alarms, timers and Pomodoro all
   * fire from the main process now, so this is how the panel learns about them.
   * Returns a disposer; call it from `register`'s teardown or a hot reload
   * leaves the previous session listening and everything sounds twice.
   */
  listen(api: ValleyPluginApi): () => void
}

function createStore(api: ValleyPluginApi): ClockStore {
  const listeners = new Set<() => void>()
  let apiRef = api
  let pendingWrite: Promise<unknown> = Promise.resolve()
  // No `window.setTimeout` maps here any more: alarms, timers and Pomodoro are
  // all armed with the host (`api.notifications.schedule`), which is what lets
  // them fire with no window open — and incidentally removes the three timer
  // maps `register`'s disposer never cleared.

  const profileNumber = (value: unknown, fallback: number): number => {
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  const configuredPomoDefaults = (): PomoConfig => {
    const s = apiRef.settings.get()
    return {
      work: profileNumber(s.pomodoroWork, 25),
      short: profileNumber(s.pomodoroShort, 5),
      long: profileNumber(s.pomodoroLong, 15),
      cycles: profileNumber(s.pomodoroCycles, 4)
    }
  }
  const profileName = (name: unknown): string => typeof name === 'string' ? name.trim() : ''
  const readProfiles = (): PomodoroProfile[] => {
    const raw = apiRef.settings.get().pomodoroProfiles
    let parsed: unknown = null
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { parsed = null }
    } else parsed = raw
    if (!Array.isArray(parsed)) {
      const defaults = configuredPomoDefaults()
      return [{ id: 'focus', name: profileName(null), ...defaults }]
    }
    const profiles = parsed.flatMap((value, index): PomodoroProfile[] => {
      if (!value || typeof value !== 'object') return []
      const item = value as Partial<PomodoroProfile>
      const id = typeof item.id === 'string' && item.id.trim() ? item.id : `pomodoro-${index + 1}`
      const fallback = configuredPomoDefaults()
      return [{
        id,
        name: profileName(item.name),
        work: profileNumber(item.work, fallback.work),
        short: profileNumber(item.short, fallback.short),
        long: profileNumber(item.long, fallback.long),
        cycles: Math.max(1, Math.round(profileNumber(item.cycles, fallback.cycles)))
      }]
    })
    return profiles.length ? profiles : [{ id: 'focus', name: profileName(null), ...configuredPomoDefaults() }]
  }
  const initialProfiles = readProfiles()
  let activeProfile = initialProfiles.find((profile) => profile.id === apiRef.settings.get().pomodoroActiveProfile) ?? initialProfiles[0]
  const cfg = (): PomoConfig => ({ work: activeProfile.work, short: activeProfile.short, long: activeProfile.long, cycles: activeProfile.cycles })

  const state: ClockStore['state'] = {
    mode: 'clock',
    selectedTimer: null,
    selectedCity: null,
    sw: { running: false, startedAt: 0, elapsed: 0, laps: [] },
    timers: [],
    timerDrag: null,
    timerDrop: null,
    worldCities: [],
    worldDrag: null,
    worldDrop: null,
    tabOrder: [],
    tabDrag: null,
    tabDrop: null,
    pomoProfiles: initialProfiles,
    pomoProfileId: activeProfile.id,
    pomoSettingsProfileId: null,
    pomoProfileDrag: null,
    pomoProfileDrop: null,
    pomo: { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: cfg().work * 60000 },
    pick: { h: 0, m: 5, s: 0, label: '' },
    alarms: [],
    alarmDrag: null,
    alarmDrop: null,
    alarmEditing: null,
    alarmRinging: []
  }

  const isDigital = (surface: 'clock' | 'stopwatch'): boolean =>
    apiRef.settings.get()[surface === 'clock' ? 'clockDisplay' : 'stopwatchDisplay'] === 'digital'

  const notify = (): void => listeners.forEach((l) => l())

  // Switching a view off while its tab is open would leave the panel on a tab
  // that no longer has a button — and keep its animation loop running.
  const syncSettings = (): void => {
    if (state.mode !== 'clock' && !viewEnabled(state.mode, apiRef.settings.get())) state.mode = 'clock'
    notify()
  }

  // ---- persistence -------------------------------------------------------
  const allRows = async (dataset: string): Promise<DatasetRecord[]> => {
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await apiRef.data.dataset(dataset).query({ limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }
  const replaceById = async (dataset: string, records: DatasetRecord[]): Promise<void> => {
    const existing = await allRows(dataset)
    await apiRef.data.dataset(dataset).batch([
      ...existing.map((row) => ({ operation: 'delete' as const, key: { id: String(row.id) } })),
      ...records.map((values) => ({ operation: 'insert' as const, values }))
    ])
  }
  const applySavedOrder = <T extends { id: string }>(items: T[], saved: readonly string[]): T[] => {
    const byId = new Map(items.map((item) => [item.id, item]))
    const ordered = saved.flatMap((id) => {
      const item = byId.get(id)
      if (!item) return []
      byId.delete(id)
      return [item]
    })
    return [...ordered, ...byId.values()]
  }
  const persistTimers = (): void => {
    const timers = state.timers.map((timer) => ({ ...timer }))
    const order = JSON.stringify(state.timers.map((timer) => timer.id))
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await replaceById('timers', timers)
      if (!(await apiRef.settings.set('timerOrder', order)).ok) throw new Error(uiText('surface.invalid'))
    })
    void pendingWrite.catch(() => {})
  }
  /**
   * Pomodoro was the one session that survived nothing — not a reload, not a
   * vault switch. Same timestamp rule as the timers: store `endsAt`, derive the
   * readout, never count ticks.
   */
  const persistPomo = (): void => {
    const snapshot = { id: 'pomodoro', ...state.pomo }
    pendingWrite = pendingWrite.catch(() => {}).then(() => apiRef.data.dataset('pomodoro_state').upsert(snapshot))
    void pendingWrite.catch(() => {})
  }
  const loadPomo = (): Promise<void> => {
    return apiRef.data.dataset('pomodoro_state').get({ id: 'pomodoro' })
      .then((record) => {
        const r = record as unknown as Partial<PomoState> | null
        if (!r) return
        const phase: PomoPhase =
          r.phase === 'short' || r.phase === 'long' || r.phase === 'work' ? r.phase : 'work'
        const endsAt = Number(r.endsAt) || 0
        // A session that ran out while the app was shut comes back paused at
        // zero rather than mid-phase — the host already announced the change.
        const running = !!r.running && endsAt > Date.now()
        state.pomo = {
          phase,
          cycle: Math.max(0, Math.floor(Number(r.cycle) || 0)),
          running,
          endsAt: running ? endsAt : 0,
          remaining: running
            ? Math.max(0, endsAt - Date.now())
            : Math.max(0, Number(r.remaining) || phaseMs(phase))
        }
        if (running) schedulePomo()
        notify()
      })
  }
  const loadPersisted = (): Promise<void> => {
    const cities = readStringList(apiRef.settings.get().worldCities)
    if (cities) state.worldCities = cities
    const tabs = readStringList(apiRef.settings.get().tabOrder)
    if (tabs) state.tabOrder = tabs
    const timerOrder = readStringList(apiRef.settings.get().timerOrder) ?? []
    return allRows('timers')
      .then((records) => {
        const now = Date.now()
        const restored: ClockTimer[] = []
        for (const r of records as unknown as ClockTimer[]) {
          if (!r || typeof r.id !== 'string') continue
          const t: ClockTimer = {
            id: r.id,
            label: typeof r.label === 'string' ? r.label : '',
            duration: Number(r.duration) || 0,
            endsAt: Number(r.endsAt) || 0,
            remaining: Number(r.remaining) || 0,
            running: !!r.running
          }
          if (t.running) {
            const left = t.endsAt - now
            if (left <= 0) {
              // Elapsed while we were gone. The row survives as a finished
              // timer instead of being deleted on sight — the host already
              // announced it as a missed notification, and a timer that simply
              // vanished used to look like the app had lost it.
              t.running = false
              t.remaining = 0
            } else {
              scheduleTimerAlarm(t)
            }
          }
          restored.push(t)
        }
        if (restored.length) {
          state.timers = applySavedOrder(restored, timerOrder)
          notify()
        }
      })
  }
  const persistCities = (): void => {
    const cities = JSON.stringify(state.worldCities)
    pendingWrite = pendingWrite.catch(() => {}).then(async () => { if (!(await apiRef.settings.set('worldCities', cities)).ok) throw new Error(uiText('surface.invalid')) })
    void pendingWrite.catch(() => {})
  }
  const setTabOrder = (order: Mode[]): void => {
    state.tabOrder = [...order]
    void apiRef.settings.set('tabOrder', JSON.stringify(state.tabOrder))
    notify()
  }
  const persistPomoProfiles = (): void => {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      if (!(await apiRef.settings.set('pomodoroProfiles', JSON.stringify(state.pomoProfiles))).ok) throw new Error(uiText('surface.invalid'))
      if (!(await apiRef.settings.set('pomodoroActiveProfile', state.pomoProfileId)).ok) throw new Error(uiText('surface.invalid'))
    })
    void pendingWrite.catch(() => {})
  }
  const mirrorPomoConfig = (profile: PomodoroProfile): void => {
    void apiRef.settings.set('pomodoroWork', profile.work)
    void apiRef.settings.set('pomodoroShort', profile.short)
    void apiRef.settings.set('pomodoroLong', profile.long)
    void apiRef.settings.set('pomodoroCycles', profile.cycles)
  }

  // ---- alarms ------------------------------------------------------------
  const persistAlarms = (): void => {
    const order = JSON.stringify(state.alarms.map((alarm) => alarm.id))
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      const existing = await allRows('alarms')
      const operations: DatasetTransactionOperation[] = [
        ...existing.map((row) => ({ dataset: 'alarms', operation: 'delete' as const, key: { id: String(row.id) } })),
        ...state.alarms.flatMap((alarm) => [
          {
            dataset: 'alarms', operation: 'insert' as const, values: {
              id: alarm.id, hour: alarm.hour, minute: alarm.minute, label: alarm.label,
              date: alarm.date ?? null, sound: alarm.sound, enabled: alarm.enabled,
              snoozedUntil: alarm.snoozedUntil ?? null
            }
          },
          ...alarm.days.map((day) => ({
            dataset: 'alarm_days', operation: 'insert' as const,
            values: { alarmId: alarm.id, day }
          }))
        ])
      ]
      if (operations.length) await apiRef.data.transaction(operations)
      if (!(await apiRef.settings.set('alarmOrder', order)).ok) throw new Error(uiText('surface.invalid'))
    })
    void pendingWrite.catch(() => {})
  }
  const defaultSound = (): AlarmSoundId => {
    const v = apiRef.settings.get().alarmSound
    return typeof v === 'string' && v in SOUNDS ? (v as AlarmSoundId) : 'beep'
  }
  const snoozeMinutes = (): number => {
    const v = apiRef.settings.get().alarmSnooze
    return typeof v === 'number' && v > 0 ? v : 9
  }
  const alarmKey = (id: string): string => `alarm:${id}`
  const clearAlarmTimeout = (id: string): void => {
    void apiRef.notifications.cancel(alarmKey(id))
  }
  const alarmTitle = (a: ClockAlarm): string => a.label.trim() || uiText('auto.25f8c55de811')
  // 24 h in the notification regardless of the user's `timeFormat`: the body is
  // a disambiguator beside the label, and the panel's own row still follows the
  // preference.
  const alarmBody = (a: ClockAlarm): string => `${pad(a.hour)}:${pad(a.minute)}`

  /**
   * Arm an alarm with the **host**, not a `window.setTimeout`.
   *
   * A renderer timer dies with its window, which is why an alarm set for 07:30
   * simply never fired if the user had closed the window — silently, because on
   * macOS the app itself stays alive. Main owns the schedule now, persists it,
   * and fires it whether or not any window exists.
   */
  function scheduleAlarm(a: ClockAlarm): void {
    const occurrences = nextOccurrences(a, 8)
    // A pending snooze is a firing too, and an earlier one — re-arming without
    // it (on reload, or on any edit) is how a snooze used to disappear.
    if (a.snoozedUntil && a.snoozedUntil > Date.now()) occurrences.unshift(a.snoozedUntil)
    if (occurrences.length === 0) {
      clearAlarmTimeout(a.id)
      return
    }
    void apiRef.notifications.schedule(alarmKey(a.id), occurrences, {
      eventId: 'alarm',
      title: alarmTitle(a),
      body: alarmBody(a),
      // Rings until answered: one short tone that the user might be nowhere
      // near is what made the old alarm useless. `snoozeMinutes` travels with
      // it so the notification's own Snooze uses the user's `alarmSnooze`.
      ring: { actions: ['stop', 'snooze'], snoozeMinutes: snoozeMinutes() }
    })
  }
  const rescheduleAlarms = (): void => {
    state.alarms.forEach(scheduleAlarm)
  }

  /**
   * The host fired one of our alarms and is now ringing it. Mirror that into
   * panel state and, while a window is alive, play the alarm's own chosen tone
   * on each repeat — with no window open, the OS notification's sound carries.
   */
  const onAlarmRing = (id: string, tick: number): void => {
    const live = state.alarms.find((x) => x.id === id)
    if (!live) return
    playSound(live.sound)
    if (!state.alarmRinging.includes(id)) state.alarmRinging.push(id)
    // Everything below advances the schedule, so it belongs to the first
    // delivery only — re-running it on every repeat would overwrite the very
    // key that is ringing.
    if (tick <= 1) {
      live.snoozedUntil = undefined
      if (live.days.length === 0 && live.enabled) {
        // A one-shot is spent: switch it off rather than deleting it, so the
        // user keeps the row (and can re-arm it) after it rings.
        live.enabled = false
      }
      persistAlarms()
    }
    notify()
  }
  const normalizeAlarm = (r: Partial<ClockAlarm>): ClockAlarm => ({
    id: typeof r.id === 'string' && r.id ? r.id : genId(),
    hour: Math.min(23, Math.max(0, Math.floor(Number(r.hour) || 0))),
    minute: Math.min(59, Math.max(0, Math.floor(Number(r.minute) || 0))),
    label: typeof r.label === 'string' ? r.label : '',
    days: Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [],
    date: typeof r.date === 'string' && r.date ? r.date : undefined,
    sound: typeof r.sound === 'string' && r.sound in SOUNDS ? (r.sound as AlarmSoundId) : 'beep',
    enabled: r.enabled !== false,
    // A snooze that already came due while the app was shut is spent — the host
    // fired it as a missed notification; keeping it would re-arm the past.
    snoozedUntil:
      typeof r.snoozedUntil === 'number' && r.snoozedUntil > Date.now() ? r.snoozedUntil : undefined
  })
  const loadAlarms = (): Promise<void> => {
    const alarmOrder = readStringList(apiRef.settings.get().alarmOrder) ?? []
    return Promise.all([allRows('alarms'), allRows('alarm_days')])
      .then(([records, days]) => {
        const restored = records
          .map((record) => ({
            ...record,
            days: days.filter((entry) => entry.alarmId === record.id).map((entry) => Number(entry.day))
          } as unknown as Partial<ClockAlarm>))
          .filter((r) => r && typeof r === 'object')
          .map(normalizeAlarm)
        if (!restored.length) return
        state.alarms = applySavedOrder(restored, alarmOrder)
        rescheduleAlarms()
        notify()
      })
  }
  const addAlarm = (init: Partial<ClockAlarm> = {}): ClockAlarm => {
    const now = new Date()
    const a = normalizeAlarm({
      hour: now.getHours(),
      minute: now.getMinutes(),
      sound: defaultSound(),
      ...init,
      id: undefined
    })
    state.alarms.push(a)
    scheduleAlarm(a)
    persistAlarms()
    notify()
    return a
  }
  const updateAlarm = (id: string, patch: Partial<ClockAlarm>): ClockAlarm | null => {
    const i = state.alarms.findIndex((a) => a.id === id)
    if (i < 0) return null
    const next = normalizeAlarm({ ...state.alarms[i], ...patch, id })
    // Selecting repeat days makes the alarm recurring — a leftover one-shot date
    // would otherwise linger in the record and reappear if the days are cleared.
    if (next.days.length > 0) next.date = undefined
    // Editing an alarm cancels its snooze: the user just told us when they want
    // it, which is not "nine minutes after the last time it rang".
    next.snoozedUntil = undefined
    state.alarms[i] = next
    state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
    scheduleAlarm(next)
    persistAlarms()
    notify()
    return next
  }
  const removeAlarm = (id: string): ClockAlarm | null => {
    const a = state.alarms.find((x) => x.id === id)
    if (!a) return null
    clearAlarmTimeout(id)
    state.alarms = state.alarms.filter((x) => x.id !== id)
    state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
    if (state.alarmEditing === id) state.alarmEditing = null
    persistAlarms()
    notify()
    return a
  }
  const alarmMove = (from: number, to: number): boolean => {
    const next = reorder(state.alarms, from, to)
    if (next.every((alarm, index) => alarm.id === state.alarms[index]?.id)) return false
    state.alarms = next
    persistAlarms()
    notify()
    return true
  }
  const toggleAlarm = (id: string, on?: boolean): boolean => {
    const a = state.alarms.find((x) => x.id === id)
    if (!a) return false
    a.enabled = on ?? !a.enabled
    // Re-arming a spent one-shot whose date has passed would never fire again —
    // drop the stale date so it means "the next time this clock reads that time".
    if (a.enabled && a.days.length === 0 && a.date && nextAlarmAt(a, new Date()) == null) a.date = undefined
    a.snoozedUntil = undefined
    state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
    if (a.enabled) scheduleAlarm(a)
    else clearAlarmTimeout(id)
    persistAlarms()
    notify()
    return a.enabled
  }
  const dismissAlarm = (id: string): void => {
    state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
    void apiRef.notifications.stopRing(alarmKey(id))
    // A recurring alarm has to be re-armed: stopping the ring also drops the
    // host's schedule for that key, and the panel's Dismiss must not be the
    // thing that silently retires a daily alarm.
    const live = state.alarms.find((x) => x.id === id)
    if (live && live.enabled) scheduleAlarm(live)
    notify()
  }
  /**
   * Postpone a ringing alarm. The host owns the delay, so a snooze now survives
   * a reload and a closed window — it used to be a `window.setTimeout` that a
   * refresh silently forgot.
   */
  const snoozeAlarm = (id: string): void => {
    const a = state.alarms.find((x) => x.id === id)
    if (!a) return
    state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
    void apiRef.notifications.snooze(alarmKey(id), snoozeMinutes())
    a.snoozedUntil = Date.now() + snoozeMinutes() * 60000
    persistAlarms()
    notify()
  }

  // ---- stopwatch ---------------------------------------------------------
  // Timestamps, not ticks — exactly like the timers below. A run is the epoch
  // ms it started at plus whatever earlier runs banked, so the elapsed time is
  // derived on read and stays true however long the panel was closed, the
  // window throttled or the app quit. The render loop only draws the number.
  const swElapsed = (): number => state.sw.elapsed + (state.sw.running ? Math.max(0, Date.now() - state.sw.startedAt) : 0)
  const persistStopwatch = (): void => {
    const snapshot = structuredClone(state.sw)
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      const laps = await allRows('stopwatch_laps')
      await apiRef.data.transaction([
        { dataset: 'stopwatch_state', operation: 'upsert', values: {
          id: 'stopwatch', running: snapshot.running, startedAt: snapshot.startedAt, elapsed: snapshot.elapsed
        } },
        ...laps.map((row) => ({
          dataset: 'stopwatch_laps', operation: 'delete' as const,
          key: { stopwatchId: 'stopwatch', position: Number(row.position) }
        })),
        ...snapshot.laps.map((elapsed, position) => ({
          dataset: 'stopwatch_laps', operation: 'insert' as const,
          values: { stopwatchId: 'stopwatch', position, elapsed }
        }))
      ])
    })
    void pendingWrite.catch(() => {})
  }
  const loadStopwatch = (): Promise<void> => {
    return Promise.all([
      apiRef.data.dataset('stopwatch_state').get({ id: 'stopwatch' }),
      allRows('stopwatch_laps')
    ]).then(([record, laps]) => {
        const r = record as unknown as Partial<SwState> | null
        if (!r) return
        const startedAt = Number(r.startedAt) || 0
        const running = !!r.running && startedAt > 0
        state.sw = {
          running,
          startedAt: running ? startedAt : 0,
          elapsed: Math.max(0, Number(r.elapsed) || 0),
          laps: laps.sort((a, b) => Number(a.position) - Number(b.position))
            .map((row) => Number(row.elapsed)).filter((value) => Number.isFinite(value))
        }
        notify()
      })
  }
  const swStart = (): void => {
    if (state.sw.running) return
    state.sw.startedAt = Date.now()
    state.sw.running = true
    persistStopwatch()
    notify()
  }
  const swStop = (): void => {
    if (!state.sw.running) return
    state.sw.elapsed = swElapsed()
    state.sw.running = false
    state.sw.startedAt = 0
    persistStopwatch()
    notify()
  }
  const swLap = (): void => {
    if (state.sw.running) {
      state.sw.laps.unshift(swElapsed())
      persistStopwatch()
      notify()
    }
  }
  const swReset = (): void => {
    state.sw.running = false
    state.sw.startedAt = 0
    state.sw.elapsed = 0
    state.sw.laps = []
    persistStopwatch()
    notify()
  }

  // ---- timers ------------------------------------------------------------
  const timerKey = (id: string): string => `timer:${id}`
  const clearTimerAlarm = (id: string): void => {
    void apiRef.notifications.cancel(timerKey(id))
  }
  /**
   * Same move as the alarms: the host holds the deadline, so a timer set for
   * twenty minutes still reaches the user with the window closed, and rings
   * rather than beeping once into an empty room.
   */
  function scheduleTimerAlarm(t: ClockTimer): void {
    void apiRef.notifications.schedule(timerKey(t.id), [t.endsAt], {
      eventId: 'timer',
      title: t.label.trim() || uiText('auto.9d9cec22f36f'),
      body: fmtCountdown(t.duration),
      ring: { actions: ['stop'] }
    })
  }
  const onTimerRing = (id: string, tick: number): void => {
    const live = state.timers.find((x) => x.id === id)
    if (live) {
      live.running = false
      live.remaining = 0
    }
    // Timers ignored `alarmSound` and always beeped; they use the configured
    // tone now, like every other thing this plugin sounds.
    playSound(defaultSound())
    if (tick <= 1) persistTimers()
    notify()
  }
  const findTimer = (id?: string): ClockTimer | undefined =>
    id ? state.timers.find((t) => t.id === id) : state.timers[state.timers.length - 1]
  const timerRemaining = (t: ClockTimer): number => (t.running ? Math.max(0, t.endsAt - Date.now()) : t.remaining)
  const addTimer = (seconds: number, label?: string): ClockTimer | null => {
    const ms = Math.round(seconds * 1000)
    if (ms <= 0) return null
    const t: ClockTimer = {
      id: genId(),
      label: label?.trim() || '',
      duration: ms,
      endsAt: Date.now() + ms,
      remaining: ms,
      running: true
    }
    state.timers.push(t)
    scheduleTimerAlarm(t)
    persistTimers()
    notify()
    return t
  }
  const pauseTimer = (id?: string): boolean => {
    const t = findTimer(id)
    if (!t || !t.running) return false
    t.remaining = Math.max(0, t.endsAt - Date.now())
    t.running = false
    clearTimerAlarm(t.id)
    persistTimers()
    notify()
    return true
  }
  const resumeTimer = (id?: string): boolean => {
    const t = findTimer(id)
    if (!t || t.running || t.remaining <= 0) return false
    t.endsAt = Date.now() + t.remaining
    t.running = true
    scheduleTimerAlarm(t)
    persistTimers()
    notify()
    return true
  }
  const cancelTimer = (id?: string): boolean => {
    const t = findTimer(id)
    if (!t) return false
    clearTimerAlarm(t.id)
    state.timers = state.timers.filter((x) => x.id !== t.id)
    persistTimers()
    notify()
    return true
  }
  const timerMove = (from: number, to: number): boolean => {
    const next = reorder(state.timers, from, to)
    if (next.every((timer, index) => timer.id === state.timers[index]?.id)) return false
    state.timers = next
    persistTimers()
    notify()
    return true
  }

  // ---- world -------------------------------------------------------------
  const worldAdd = (query: string): City | null => {
    const q = query.trim()
    if (!q) return null
    const city =
      CITIES.find((c) => cityId(c).toLowerCase() === q.toLowerCase()) ??
      CITIES.find((c) => normalizeCityTerm(c.name) === normalizeCityTerm(q)) ??
      CITIES.find((c) => cityMatches(c, q))
    const id = city ? cityId(city) : ''
    if (!city || state.worldCities.includes(id)) return city ?? null
    state.worldCities.push(id)
    persistCities()
    notify()
    return city
  }
  const worldRemove = (tz: string): boolean => {
    const before = state.worldCities.length
    state.worldCities = state.worldCities.filter((x) => x !== tz)
    if (state.worldCities.length === before) return false
    persistCities()
    notify()
    return true
  }
  const worldMove = (from: number, to: number): boolean => {
    const next = reorder(state.worldCities, from, to)
    if (next === state.worldCities || next.every((tz, i) => tz === state.worldCities[i])) return false
    state.worldCities = next
    persistCities()
    notify()
    return true
  }

  // ---- pomodoro ----------------------------------------------------------
  const phaseMs = (phase: PomoPhase): number => {
    const c = cfg()
    return (phase === 'work' ? c.work : phase === 'short' ? c.short : c.long) * 60000
  }
  const resetPomoForProfile = (): void => {
    clearPomoAlarm()
    state.pomo = { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: phaseMs('work') }
    persistPomo()
  }
  const selectPomoProfile = (id: string): void => {
    const profile = state.pomoProfiles.find((entry) => entry.id === id)
    if (!profile || profile.id === state.pomoProfileId) return
    activeProfile = profile
    state.pomoProfileId = profile.id
    mirrorPomoConfig(profile)
    resetPomoForProfile()
    persistPomoProfiles()
    notify()
  }
  const addPomoProfile = (name?: string): PomodoroProfile => {
    const profile: PomodoroProfile = {
      id: `pomodoro-${Date.now().toString(36)}-${uid++}`,
      name: name?.trim() || `${uiText('auto.212e4618d030')} ${state.pomoProfiles.length + 1}`,
      ...cfg()
    }
    state.pomoProfiles = [...state.pomoProfiles, profile]
    activeProfile = profile
    state.pomoProfileId = profile.id
    mirrorPomoConfig(profile)
    resetPomoForProfile()
    persistPomoProfiles()
    notify()
    return profile
  }
  const renamePomoProfile = (id: string, name: string, commit = false): void => {
    const profile = state.pomoProfiles.find((entry) => entry.id === id)
    if (!profile) return
    const next = commit ? name.trim() : name
    if (next === profile.name) return
    profile.name = next
    persistPomoProfiles()
    notify()
  }
  const pomoProfileMove = (from: number, to: number): boolean => {
    const next = reorder(state.pomoProfiles, from, to)
    if (next.every((profile, index) => profile.id === state.pomoProfiles[index]?.id)) return false
    state.pomoProfiles = next
    persistPomoProfiles()
    notify()
    return true
  }
  const removePomoProfile = (id: string): void => {
    if (state.pomoProfiles.length <= 1) return
    const next = state.pomoProfiles.filter((profile) => profile.id !== id)
    if (next.length === state.pomoProfiles.length) return
    state.pomoProfiles = next
    if (id === state.pomoProfileId) {
      activeProfile = next[0]
      state.pomoProfileId = activeProfile.id
      mirrorPomoConfig(activeProfile)
      resetPomoForProfile()
    }
    persistPomoProfiles()
    notify()
  }
  const updatePomoProfile = (id: string, patch: Partial<PomoConfig>): void => {
    const profile = state.pomoProfiles.find((entry) => entry.id === id)
    if (!profile) return
    const next: PomodoroProfile = {
      ...profile,
      work: profileNumber(patch.work, profile.work),
      short: profileNumber(patch.short, profile.short),
      long: profileNumber(patch.long, profile.long),
      cycles: Math.max(1, Math.round(profileNumber(patch.cycles, profile.cycles)))
    }
    state.pomoProfiles = state.pomoProfiles.map((entry) => entry.id === id ? next : entry)
    if (id === state.pomoProfileId) {
      activeProfile = next
      mirrorPomoConfig(next)
      if (!state.pomo.running) state.pomo.remaining = phaseMs(state.pomo.phase)
    }
    persistPomoProfiles()
    notify()
  }
  const POMO_KEY = 'pomodoro'
  const clearPomoAlarm = (): void => {
    void apiRef.notifications.cancel(POMO_KEY)
  }
  const pomoRemaining = (): number => (state.pomo.running ? Math.max(0, state.pomo.endsAt - Date.now()) : state.pomo.remaining)
  /** No ring: a phase change is an announcement, not something to answer. */
  const schedulePomo = (): void => {
    void apiRef.notifications.schedule(POMO_KEY, [Date.now() + pomoRemaining()], {
      eventId: 'pomodoro',
      title: uiText('auto.212e4618d030'),
      body: pomoPhaseName(pomodoroNextPhase(state.pomo.phase, state.pomo.cycle, cfg().cycles).phase)
    })
  }
  const onPomoRing = (): void => {
    const next = pomodoroNextPhase(state.pomo.phase, state.pomo.cycle, cfg().cycles)
    state.pomo.phase = next.phase
    state.pomo.cycle = next.cycle
    state.pomo.remaining = phaseMs(next.phase)
    state.pomo.endsAt = Date.now() + state.pomo.remaining
    playSound(defaultSound())
    schedulePomo()
    persistPomo()
    notify()
  }
  const pomoStart = (): void => {
    if (state.pomo.running) return
    if (state.pomo.remaining <= 0) state.pomo.remaining = phaseMs(state.pomo.phase)
    state.pomo.endsAt = Date.now() + state.pomo.remaining
    state.pomo.running = true
    schedulePomo()
    persistPomo()
    notify()
  }
  const pomoPause = (): void => {
    if (!state.pomo.running) return
    state.pomo.remaining = pomoRemaining()
    state.pomo.running = false
    clearPomoAlarm()
    persistPomo()
    notify()
  }
  const pomoReset = (): void => {
    clearPomoAlarm()
    state.pomo = { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: phaseMs('work') }
    persistPomo()
    notify()
  }
  const pomoSkip = (): void => {
    const next = pomodoroNextPhase(state.pomo.phase, state.pomo.cycle, cfg().cycles)
    state.pomo.phase = next.phase
    state.pomo.cycle = next.cycle
    state.pomo.remaining = phaseMs(next.phase)
    if (state.pomo.running) {
      state.pomo.endsAt = Date.now() + state.pomo.remaining
      schedulePomo()
    }
    persistPomo()
    notify()
  }

  const store: ClockStore = {
    ready: Promise.resolve(),
    flush: async () => { await pendingWrite },
    updateTimer: (id, patch) => {
      const timer = state.timers.find((entry) => entry.id === id)
      if (!timer || (patch.duration !== undefined && (timer.running || !Number.isFinite(patch.duration) || patch.duration <= 0))) return null
      if (patch.label !== undefined) timer.label = patch.label
      if (patch.duration !== undefined) { timer.duration = patch.duration; timer.remaining = patch.duration; timer.endsAt = 0 }
      persistTimers()
      notify()
      return timer
    },
    setApi: (a) => {
      apiRef = a
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    notify,
    state,
    pomoConfig: cfg,
    pomoProfiles: () => state.pomoProfiles,
    selectPomoProfile,
    addPomoProfile,
    renamePomoProfile,
    pomoProfileMove,
    removePomoProfile,
    updatePomoProfile,
    isDigital,
    syncSettings,
    setMode: (m) => {
      state.mode = m
      notify()
    },
    swStart,
    swStop,
    swLap,
    swReset,
    swElapsed,
    addTimer,
    pauseTimer,
    resumeTimer,
    cancelTimer,
    timerRemaining,
    timerMove,
    worldAdd,
    worldRemove,
    worldMove,
    setTabOrder,
    defaultSound,
    addAlarm,
    updateAlarm,
    removeAlarm,
    alarmMove,
    toggleAlarm,
    dismissAlarm,
    snoozeAlarm,
    setAlarmEditing: (id) => {
      state.alarmEditing = id
      notify()
    },
    pomoStart,
    pomoPause,
    pomoReset,
    pomoSkip,
    pomoRemaining,
    /**
     * Subscribe to the host's notification stream. Called once per `register`;
     * the returned disposer is what stops the previous session's handlers
     * surviving a hot reload and firing twice.
     */
    listen: (api) => {
      const offRing = api.notifications.onRing(({ key, tick }) => {
        if (key.startsWith('alarm:')) onAlarmRing(key.slice('alarm:'.length), tick)
        else if (key.startsWith('timer:')) onTimerRing(key.slice('timer:'.length), tick)
        else if (key === POMO_KEY) onPomoRing()
      })
      const offAction = api.notifications.onAction(({ key, action }) => {
        if (action === 'click') return
        if (key.startsWith('alarm:')) {
          const id = key.slice('alarm:'.length)
          // The host already stopped or re-armed the ring; this mirrors the
          // answer into panel state so the Snooze/Dismiss row clears whether it
          // was pressed here or on the OS notification itself.
          state.alarmRinging = state.alarmRinging.filter((x) => x !== id)
          if (action === 'snooze') {
            const live = state.alarms.find((x) => x.id === id)
            if (live) {
              live.snoozedUntil = Date.now() + snoozeMinutes() * 60000
              persistAlarms()
            }
          }
          notify()
        }
      })
      return () => {
        offRing()
        offAction()
      }
      // Nothing cancels the host's schedules here on purpose: outliving this
      // renderer is the entire point of moving them out of it.
    }
  }
  store.ready = Promise.all([loadPersisted(), loadStopwatch(), loadAlarms(), loadPomo()]).then(() => {})
  void store.ready.catch(() => {})
  return store
}

function getStore(api: ValleyPluginApi): ClockStore {
  const store = api.runtime.getOrCreate(STORE_KEY, () => createStore(api))
  store.setApi(api)
  return store
}

/** Resolve a CLI alarm reference: exact id, then "HH:MM", then a label match. */
function findAlarm(store: ClockStore, query: string): ClockAlarm | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return store.state.alarms[store.state.alarms.length - 1]
  const byId = store.state.alarms.find((a) => a.id === query.trim())
  if (byId) return byId
  const t = parseClockTime(q)
  if (t) {
    const byTime = store.state.alarms.find((a) => a.hour === t.hour && a.minute === t.minute)
    if (byTime) return byTime
  }
  return store.state.alarms.find((a) => a.label.toLowerCase().includes(q))
}

// ---- Commands --------------------------------------------------------------
function registerCommands(api: ValleyPluginApi, store: ClockStore): Array<() => void> {
  const offs: Array<() => void> = []
  const reg = <I, O, E extends 'read' | 'write'>(cmd: PluginCommand<I, O, E>): void => {
    offs.push(api.commands.register({ ...cmd,
      ...(cmd.sideEffect === 'write' && !cmd.revision ? { revision: async () => { await store.ready; const { mode, sw, timers, worldCities, alarms, pomo } = store.state; return { mode, sw, timers, worldCities, alarms, pomo, clockDisplay: store.isDigital('clock'), stopwatchDisplay: store.isDigital('stopwatch') } } } : {}),
      run: async (input: I, context) => { await store.ready; const output = await cmd.run(input, context); if (cmd.sideEffect === 'write') await store.flush(); return output }
    }))
  }
  const str = (o: unknown, k: string): string => {
    const v = (o as Record<string, unknown>)?.[k]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  }
  // Wrap a synchronous inverse as the bus's RevertOperation (one ⌘Z entry).
  const rev = (label: string, run: () => unknown): { label: string; run: () => Promise<void> } => ({
    label,
    run: async () => {
      await run()
      await store.flush()
    }
  })

  reg({
    id: 'mode',
    label: "Clock: Switch tab", labelKey: 'auto.6b1b8322b245',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { mode: { enum: ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro'] } }, required: ['mode'], additionalProperties: false },
      parse: (raw) => {
        const m = str(raw, 'mode').toLowerCase()
        const valid = ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro']
        if (!valid.includes(m)) throw new Error(`Usage: clock mode <${valid.join('|')}>`)
        return { mode: m as Mode }
      },
      fromCli: (args) => {
        const m = (args[0] ?? '').toLowerCase()
        return { mode: m as Mode }
      }
    },
    run: ({ mode }) => {
      const prev = store.state.mode
      store.setMode(mode)
      return { value: { mode }, revert: rev('Switch clock tab', () => store.setMode(prev)) }
    },
    formatCli: (v) => `Clock: ${v.mode}`
  })

  // Display style (persisted setting; drives the analog/digital face). Only the
  // clock and the stopwatch have one — timers and Pomodoro are always digital.
  const DISPLAY_KEY = { clock: 'clockDisplay', stopwatch: 'stopwatchDisplay' } as const
  reg({
    id: 'display',
    label: "Clock: Set display style", labelKey: 'auto.6e4df07e9445',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { surface: { enum: ['clock', 'stopwatch'] }, style: { enum: ['analog', 'digital'] } }, required: ['surface', 'style'], additionalProperties: false },
      parse: (raw) => {
        const surface = str(raw, 'surface').toLowerCase()
        const style = str(raw, 'style').toLowerCase()
        if (!['clock', 'stopwatch'].includes(surface) || !['analog', 'digital'].includes(style))
          throw new Error('Usage: clock display <clock|stopwatch> <analog|digital>')
        return { surface: surface as keyof typeof DISPLAY_KEY, style: style as 'analog' | 'digital' }
      },
      fromCli: (args) => ({
        surface: (args[0] ?? '').toLowerCase() as keyof typeof DISPLAY_KEY,
        style: (args[1] ?? '').toLowerCase() as 'analog' | 'digital'
      })
    },
    run: async ({ surface, style }) => {
      const key = DISPLAY_KEY[surface]
      const prev: 'analog' | 'digital' = store.isDigital(surface) ? 'digital' : 'analog'
      if (!(await api.settings.set(key, style)).ok) throw new Error(uiText('surface.invalid'))
      store.syncSettings()
      return {
        value: { surface, style },
        revert: rev('Restore display style', async () => {
          if (!(await api.settings.set(key, prev)).ok) throw new Error(uiText('surface.invalid'))
          store.syncSettings()
        })
      }
    },
    formatCli: (v) => `${v.surface} display set to ${v.style}`
  })

  // Stopwatch
  reg({
    id: 'sw-start',
    label: "Clock: Start stopwatch", labelKey: 'auto.bc5b66e6c26b',
    sideEffect: 'write',
    run: () => {
      store.swStart()
      return { value: { running: true }, revert: rev('Stop stopwatch', () => store.swStop()) }
    },
    formatCli: () => 'Stopwatch started'
  })
  reg({
    id: 'sw-stop',
    label: "Clock: Stop stopwatch", labelKey: 'auto.557994cd7327',
    sideEffect: 'write',
    run: () => {
      store.swStop()
      return { value: { elapsed: store.swElapsed() }, revert: rev('Resume stopwatch', () => store.swStart()) }
    },
    formatCli: (v) => `Stopwatch stopped at ${fmtStopwatch(v.elapsed)}`
  })
  reg({
    id: 'sw-lap',
    label: "Clock: Lap stopwatch", labelKey: 'auto.ef22d051b2c7',
    sideEffect: 'write',
    run: () => {
      store.swLap()
      return { value: { laps: store.state.sw.laps.length }, revert: null }
    },
    formatCli: (v) => `Lap ${v.laps} recorded`
  })
  reg({
    id: 'sw-reset',
    label: "Clock: Reset stopwatch", labelKey: 'auto.bbb44faa3c13',
    sideEffect: 'write',
    run: () => {
      store.swReset()
      return { value: { reset: true }, revert: null }
    },
    formatCli: () => 'Stopwatch reset'
  })

  // Timers
  reg({
    id: 'timer-start',
    label: "Clock: Start a timer", labelKey: 'auto.a6575150b41a',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { duration: { type: 'string', minLength: 1 }, label: { type: 'string' } }, required: ['duration'], additionalProperties: false },
      parse: (raw) => {
        const secs = parseDuration(str(raw, 'duration'))
        if (secs <= 0) throw new Error('Usage: clock timer-start <duration e.g. 5m> [--label "Tea"]')
        return { seconds: secs, label: str(raw, 'label') }
      },
      fromCli: (args, flags) => ({
        duration: args.join(' '),
        label: typeof flags.label === 'string' ? flags.label : ''
      })
    },
    run: ({ seconds, label }) => {
      const t = store.addTimer(seconds, label)
      if (!t) throw new Error('Could not create timer.')
      return { value: { id: t.id, duration: t.duration, label: t.label }, revert: rev('Cancel timer', () => store.cancelTimer(t.id)) }
    },
    formatCli: (v) => `Timer started: ${fmtCountdown(v.duration)}${v.label ? ` (${v.label})` : ''}`
  })
  reg({
    id: 'timer-pause',
    label: "Clock: Pause a timer", labelKey: 'auto.8002918e458d',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: ({ id }) => {
      const ok = store.pauseTimer(id)
      return { value: { paused: ok }, revert: rev('Resume timer', () => store.resumeTimer(id)) }
    },
    formatCli: (v) => (v.paused ? 'Timer paused' : 'No running timer')
  })
  reg({
    id: 'timer-resume',
    label: "Clock: Resume a timer", labelKey: 'auto.3db28890b6e6',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: ({ id }) => {
      const ok = store.resumeTimer(id)
      return { value: { resumed: ok }, revert: rev('Pause timer', () => store.pauseTimer(id)) }
    },
    formatCli: (v) => (v.resumed ? 'Timer resumed' : 'No paused timer')
  })
  reg({
    id: 'timer-cancel',
    label: "Clock: Cancel a timer", labelKey: 'auto.9ffe5ff9b2a2',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: ({ id }) => {
      const ok = store.cancelTimer(id)
      return { value: { cancelled: ok }, revert: null }
    },
    formatCli: (v) => (v.cancelled ? 'Timer cancelled' : 'No timer')
  })
  reg({
    id: 'timer-list',
    label: "Clock: List timers", labelKey: 'auto.fdb76665287e',
    sideEffect: 'read',
    run: () => ({
      timers: store.state.timers.map((t) => ({
        id: t.id,
        label: t.label,
        remaining: store.timerRemaining(t),
        running: t.running
      }))
    }),
    formatCli: (v) =>
      v.timers.length
        ? v.timers.map((t) => `${t.id} ${fmtCountdown(t.remaining)}${t.running ? '' : ' (paused)'}${t.label ? ` ${t.label}` : ''}`).join('\n')
        : 'No timers'
  })

  // World clock
  reg({
    id: 'world-add',
    label: "Clock: Add a world city", labelKey: 'auto.09d77f0a794a',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        if (!q) throw new Error('Usage: clock world-add "<city>"')
        return { query: q }
      },
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: ({ query }) => {
      const city = store.worldAdd(query)
      if (!city) throw new Error(`No known city matching "${query}".`)
      return { value: { name: city.name, tz: city.tz }, revert: rev('Remove city', () => store.worldRemove(cityId(city))) }
    },
    formatCli: (v) => `Added ${v.name} (${cityTime(v.tz, new Date())})`
  })
  reg({
    id: 'world-remove',
    label: "Clock: Remove a world city", labelKey: 'auto.aba9b24a1f72',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        if (!q) throw new Error('Usage: clock world-remove "<city>"')
        return { query: q }
      },
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: ({ query }) => {
      const normalized = normalizeCityTerm(query)
      const match =
        store.state.worldCities.find((id) => id.toLowerCase() === query.toLowerCase()) ??
        store.state.worldCities.find((id) => normalizeCityTerm(cityName(id)) === normalized) ??
        store.state.worldCities.find((id) => {
          const city = cityFor(id)
          return city ? cityMatches(city, query) : normalizeCityTerm(cityName(id)).includes(normalized)
        })
      if (!match) throw new Error(`No world city matching "${query}".`)
      const ok = store.worldRemove(match)
      return { value: { removed: ok, tz: cityZone(match) }, revert: rev('Add city', () => store.worldAdd(match)) }
    },
    formatCli: (v) => (v.removed ? 'City removed' : 'City was not in the list')
  })
  reg({
    id: 'world-list',
    label: "Clock: List world cities", labelKey: 'auto.6a65a293678d',
    sideEffect: 'read',
    run: () => {
      const now = new Date()
      return { cities: store.state.worldCities.map((id) => ({ name: cityName(id), tz: cityZone(id), time: cityTime(id, now) })) }
    },
    formatCli: (v) => (v.cities.length ? v.cities.map((c) => `${c.time}  ${c.name}`).join('\n') : 'No cities')
  })
  reg({
    id: 'world-move',
    label: "Clock: Reorder a world city", labelKey: 'auto.b3c6e9298c12',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 }, position: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        const pos = Number(str(raw, 'position') || str(raw, 'to'))
        if (!q || !Number.isFinite(pos) || pos < 1) throw new Error('Usage: clock world-move "<city>" <position>')
        return { query: q, position: Math.floor(pos) }
      },
      fromCli: (args) => {
        const position = Number(args[args.length - 1])
        return {
          query: args.slice(0, -1).join(' '),
          position: Number.isFinite(position) ? Math.floor(position) : 0
        }
      }
    },
    run: ({ query, position }) => {
      const q = normalizeCityTerm(query)
      let from = store.state.worldCities.findIndex((id) => id.toLowerCase() === query.toLowerCase())
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)) === q)
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)).includes(q))
      if (from < 0) throw new Error(`"${query}" is not in the world list.`)
      const to = Math.min(Math.max(position - 1, 0), store.state.worldCities.length - 1)
      const ok = store.worldMove(from, to)
      const tz = store.state.worldCities[to]
      return { value: { moved: ok, tz, position: to + 1 }, revert: rev('Move city back', () => store.worldMove(to, from)) }
    },
    formatCli: (v) => (v.moved ? `Moved ${cityName(v.tz)} to position ${v.position}` : 'City already in place')
  })

  // Alarms
  const fmtAlarm = (a: ClockAlarm): string =>
    `${pad(a.hour)}:${pad(a.minute)}${a.label ? ` ${a.label}` : ''}${a.enabled ? '' : ' (off)'}`
  reg({
    id: 'alarm-add',
    label: "Clock: Add an alarm", labelKey: 'auto.66ddbbee498d',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { time: { type: 'string', minLength: 1 }, label: { type: 'string' }, days: { type: 'string' } }, required: ['time'], additionalProperties: false },
      parse: (raw) => {
        const t = parseClockTime(str(raw, 'time'))
        if (!t) throw new Error('Usage: clock alarm-add <HH:MM> [--label "Wake up"] [--days mon,tue]')
        return { hour: t.hour, minute: t.minute, label: str(raw, 'label'), days: parseDays(str(raw, 'days')) }
      },
      fromCli: (args, flags) => ({ time: args[0] ?? '', label: typeof flags.label === 'string' ? flags.label : '', days: typeof flags.days === 'string' ? flags.days : '' })
    },
    run: ({ hour, minute, label, days }) => {
      if (hour < 0) throw new Error('Usage: clock alarm-add <HH:MM> [--label "Wake up"] [--days mon,tue]')
      const a = store.addAlarm({ hour, minute, label, days })
      return { value: { id: a.id, hour: a.hour, minute: a.minute, label: a.label }, revert: rev('Remove alarm', () => void store.removeAlarm(a.id)) }
    },
    formatCli: (v) => `Alarm set for ${pad(v.hour)}:${pad(v.minute)}${v.label ? ` (${v.label})` : ''}`
  })
  reg({
    id: 'alarm-remove',
    label: "Clock: Remove an alarm", labelKey: 'auto.82d01f840bd9',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, alarm: { type: 'string', minLength: 1 }, time: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ query: str(raw, 'id') || str(raw, 'alarm') || str(raw, 'time') || str(raw, 'query') }),
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: ({ query }) => {
      const a = findAlarm(store, query)
      if (!a) throw new Error(`No alarm matching "${query}".`)
      const snapshot = { ...a }
      store.removeAlarm(a.id)
      return {
        value: { id: a.id, removed: true },
        revert: rev('Restore alarm', () => void store.addAlarm(snapshot))
      }
    },
    formatCli: () => 'Alarm removed'
  })
  reg({
    id: 'alarm-toggle',
    label: "Clock: Toggle an alarm", labelKey: 'auto.091f8858665b',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, alarm: { type: 'string', minLength: 1 }, time: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ query: str(raw, 'id') || str(raw, 'alarm') || str(raw, 'time') || str(raw, 'query') }),
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: ({ query }) => {
      const a = findAlarm(store, query)
      if (!a) throw new Error(`No alarm matching "${query}".`)
      const was = a.enabled
      const now = store.toggleAlarm(a.id)
      return { value: { id: a.id, enabled: now }, revert: rev('Restore alarm state', () => void store.toggleAlarm(a.id, was)) }
    },
    formatCli: (v) => (v.enabled ? 'Alarm enabled' : 'Alarm disabled')
  })
  reg({
    id: 'alarm-list',
    label: "Clock: List alarms", labelKey: 'auto.aa21c27f35a8',
    sideEffect: 'read',
    run: () => ({ alarms: store.state.alarms.map((a) => ({ id: a.id, text: fmtAlarm(a) })) }),
    formatCli: (v) => (v.alarms.length ? v.alarms.map((a) => `${a.id}  ${a.text}`).join('\n') : 'No alarms')
  })

  // Pomodoro
  reg({
    id: 'pomodoro-start',
    label: "Clock: Start Pomodoro", labelKey: 'auto.f65ee22b00b8',
    sideEffect: 'write',
    run: () => {
      store.pomoStart()
      return { value: { phase: store.state.pomo.phase }, revert: rev('Pause Pomodoro', () => store.pomoPause()) }
    },
    formatCli: (v) => `Pomodoro started (${v.phase})`
  })
  reg({
    id: 'pomodoro-pause',
    label: "Clock: Pause Pomodoro", labelKey: 'auto.595d0b10adc0',
    sideEffect: 'write',
    run: () => {
      store.pomoPause()
      return { value: { paused: true }, revert: rev('Resume Pomodoro', () => store.pomoStart()) }
    },
    formatCli: () => 'Pomodoro paused'
  })
  reg({
    id: 'pomodoro-reset',
    label: "Clock: Reset Pomodoro", labelKey: 'auto.5aee8fbc51d9',
    sideEffect: 'write',
    run: () => {
      store.pomoReset()
      return { value: { reset: true }, revert: null }
    },
    formatCli: () => 'Pomodoro reset'
  })
  reg({
    id: 'pomodoro-skip',
    label: "Clock: Skip Pomodoro phase", labelKey: 'auto.53b04ab58b1c',
    sideEffect: 'write',
    run: () => {
      store.pomoSkip()
      return { value: { phase: store.state.pomo.phase }, revert: null }
    },
    formatCli: (v) => `Skipped to ${v.phase}`
  })

  return offs
}

// ---- View ------------------------------------------------------------------
export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  const disposeStyles = injectStyles()
  const React = api.React
  const h = React.createElement
  const { SelectField } = api.ui.settings
  const store = getStore(api)

  // Lucide-style stroke icons (16px, currentColor) — the same idiom the other
  // plugins use, so the tab strip matches the app's icon rail.
  const iconSvg = (...children: ReturnType<typeof h>[]): ReturnType<typeof h> =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' }
      },
      ...children
    )
  const playSoundIcon = (): ReturnType<typeof h> => iconSvg(p('play', 'M8 5l11 7-11 7Z'))
  const pauseSoundIcon = (): ReturnType<typeof h> => iconSvg(p('left', 'M8 5v14'), p('right', 'M16 5v14'))
  const SoundPreview = ({ sound }: { sound: AlarmSoundId }): ReturnType<typeof h> => {
    const [playing, setPlaying] = React.useState(false)
    const playback = React.useRef<SoundPlayback | null>(null)
    React.useEffect(() => () => playback.current?.stop(), [])
    const toggle = (): void => {
      const current = playback.current
      if (!current) {
        const next = playSound(sound, () => {
          playback.current = null
          setPlaying(false)
        })
        if (!next) return
        playback.current = next
        setPlaying(true)
      } else if (playing) {
        current.pause()
        setPlaying(false)
      } else {
        current.resume()
        setPlaying(true)
      }
    }
    return h(
      'button',
      {
        type: 'button',
        className: `clock-sound-preview${playing ? ' is-playing' : ''}`,
        'aria-label': uiText('auto.83c3ad48bcdb'),
        'aria-pressed': playing,
        title: uiText('auto.83c3ad48bcdb'),
        onClick: toggle
      },
      playing ? pauseSoundIcon() : playSoundIcon()
    )
  }
  const p = (key: string, d: string): ReturnType<typeof h> => h('path', { key, d })
  const editMenuIcon = (): ReturnType<typeof h> =>
    iconSvg(p('line', 'M12 20h9'), p('pencil', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'))
  const trashMenuIcon = (): ReturnType<typeof h> =>
    iconSvg(
      p('top', 'M3 6h18'),
      p('body', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'),
      p('lid', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2')
    )

  /* Filled counterpart of `iconSvg`, for the four tabs whose glyphs come from
     solid-fill icon sets. Plugins can't bundle react-icons, so the paths are
     inlined verbatim (with their native viewBox) exactly as the assistant
     plugin's icons.tsx does. */
  const filledSvg = (viewBox: string, ...children: ReturnType<typeof h>[]): ReturnType<typeof h> =>
    h(
      'svg',
      {
        viewBox,
        width: 16,
        height: 16,
        fill: 'currentColor',
        stroke: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' }
      },
      ...children
    )

  const tabIcon: Record<Mode, () => ReturnType<typeof h>> = {
    clock: () => iconSvg(h('circle', { key: 'c', cx: 12, cy: 12, r: 10 }), p('h', 'M12 6v6l4 2')),
    /* react-icons MdOutlineAccessAlarm */
    alarm: () =>
      filledSvg(
        '0 0 24 24',
        p(
          'd',
          'm22 5.72-4.6-3.86-1.29 1.53 4.6 3.86zM7.88 3.39 6.6 1.86 2 5.71l1.29 1.53zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9a9 9 0 0 0 0-18m0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7'
        )
      ),
    /* react-icons BsStopwatch */
    stopwatch: () =>
      filledSvg(
        '0 0 16 16',
        p('hand', 'M8.5 5.6a.5.5 0 1 0-1 0v2.9h-3a.5.5 0 0 0 0 1H8a.5.5 0 0 0 .5-.5z'),
        p(
          'body',
          'M6.5 1A.5.5 0 0 1 7 .5h2a.5.5 0 0 1 0 1v.57c1.36.196 2.594.78 3.584 1.64l.012-.013.354-.354-.354-.353a.5.5 0 0 1 .707-.708l1.414 1.415a.5.5 0 1 1-.707.707l-.353-.354-.354.354-.013.012A7 7 0 1 1 7 2.071V1.5a.5.5 0 0 1-.5-.5M8 3a6 6 0 1 0 .001 12A6 6 0 0 0 8 3'
        )
      ),
    /* react-icons IoIosTimer */
    timer: () =>
      filledSvg(
        '0 0 512 512',
        p(
          'body',
          'M256 456c-110.3 0-200-89.7-200-200 0-54.8 21.7-105.9 61.2-144 6.4-6.2 16.6-6 22.7.4 6.2 6.4 6 16.6-.4 22.7-33.1 32-51.3 74.9-51.3 120.9 0 92.5 75.3 167.8 167.8 167.8S423.8 348.5 423.8 256c0-87.1-66.7-159-151.8-167.1v62.6c0 8.9-7.2 16.1-16.1 16.1s-16.1-7.2-16.1-16.1V72.1c0-8.9 7.2-16.1 16.1-16.1 110.3 0 200 89.7 200 200S366.3 456 256 456z'
        ),
        p(
          'hand',
          'M175.9 161.9l99.5 71.5c13.5 9.7 16.7 28.5 7 42s-28.5 16.7-42 7c-2.8-2-5.2-4.4-7-7l-71.5-99.5c-3.2-4.5-2.2-10.8 2.3-14 3.6-2.6 8.3-2.4 11.7 0z'
        )
      ),
    /* react-icons RxLapTimer */
    pomodoro: () =>
      filledSvg(
        '0 0 15 15',
        p(
          'd',
          'M9.00037 0C9.27633 0.000210167 9.50037 0.223987 9.50037 0.5C9.50037 0.776013 9.27633 0.99979 9.00037 1H8.00037V2.12109C9.09875 2.20608 10.1186 2.56801 10.9916 3.1377C11.0114 3.1099 11.033 3.08255 11.058 3.05762L12.058 2.05762L12.1566 1.97754C12.3992 1.81778 12.7293 1.84422 12.9427 2.05762C13.156 2.27105 13.1826 2.60127 13.0228 2.84375L12.9427 2.94238L11.9662 3.91797C13.1585 5.08042 13.8997 6.70335 13.8998 8.5C13.8996 12.0343 11.0347 14.8992 7.50037 14.8994C3.96587 14.8994 1.10019 12.0344 1.09998 8.5C1.10016 5.13385 3.69958 2.37627 7.00037 2.12109V1H6.00037C5.72422 1 5.50037 0.776142 5.50037 0.5C5.50037 0.223858 5.72422 0 6.00037 0H9.00037ZM7.50037 3.09961C4.51815 3.09961 2.10017 5.51783 2.09998 8.5C2.10019 11.4822 4.51816 13.8994 7.50037 13.8994C10.4824 13.8992 12.8996 11.482 12.8998 8.5C12.8996 5.51796 10.4824 3.09982 7.50037 3.09961ZM7.50037 8.5L10.6117 11.6113C9.81554 12.4075 8.71524 12.8993 7.50037 12.8994C5.07044 12.8994 3.10019 10.9299 3.09998 8.5C3.10017 6.07012 5.07044 4.09961 7.50037 4.09961V8.5Z'
        )
      )
  }

  // Geometry helpers (analog faces) ----------------------------------------
  const pt = (deg: number, r: number): { x: number; y: number } => {
    const rad = ((deg - 90) * Math.PI) / 180
    return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) }
  }
  const along = (deg: number, dist: number, perp: number): { x: number; y: number } => {
    const rad = ((deg - 90) * Math.PI) / 180
    return {
      x: 50 + dist * Math.cos(rad) - perp * Math.sin(rad),
      y: 50 + dist * Math.sin(rad) + perp * Math.cos(rad)
    }
  }
  const hand = (
    key: string,
    deg: number,
    len: number,
    shoulder: number,
    halfW: number,
    tail: number
  ): ReturnType<typeof h> => {
    const tip = along(deg, len, 0)
    const tl = along(deg, -tail, 0)
    const cr = along(deg, shoulder, halfW * 2)
    const cl = along(deg, shoulder, -halfW * 2)
    return h('path', {
      key,
      d: `M ${tl.x} ${tl.y} Q ${cr.x} ${cr.y} ${tip.x} ${tip.y} Q ${cl.x} ${cl.y} ${tl.x} ${tl.y} Z`,
      fill: INK
    })
  }
  const baton = (key: string, deg: number, outer: number, inner: number, w: number, perp = 0): ReturnType<typeof h> => {
    const a = along(deg, outer, perp)
    const b = along(deg, inner, perp)
    return h('line', { key, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: INK, strokeWidth: w, strokeLinecap: 'butt' })
  }
  const dialMarks: ReturnType<typeof h>[] = []
  for (let i = 0; i < 60; i += 1) {
    const hour = i % 5 === 0
    const deg = i * 6
    if (i === 0) {
      dialMarks.push(baton('m0a', deg, 47, 39, 2.2, 1.6))
      dialMarks.push(baton('m0b', deg, 47, 39, 2.2, -1.6))
    } else if (hour) {
      dialMarks.push(baton(`m${i}`, deg, 47, 39, 2.2))
    } else {
      dialMarks.push(baton(`m${i}`, deg, 47, 44.4, 0.8))
    }
  }
  const sbbDial = (...children: (ReturnType<typeof h> | false)[]): ReturnType<typeof h> =>
    h(
      'svg',
      { viewBox: '0 0 100 100', width: '100%', height: '100%', style: { display: 'block' } },
      h('circle', { cx: 50, cy: 50, r: 49, fill: FACE, stroke: DIAL_EDGE, strokeWidth: 0.5 }),
      ...dialMarks,
      ...children
    )

  // Digital readout — Valley type scale, sentence case, tabular numerals.
  const digital = (text: string, sub?: string, size: '' | 'md' | 'sm' = ''): ReturnType<typeof h> =>
    h(
      'div',
      { className: 'clock-center', style: { gap: 'var(--space-1)' } },
      h('div', { className: `clock-readout ${size}`.trim() }, text),
      sub ? h('div', { className: 'clock-sub' }, sub) : false
    )

  // SBB / Mondaine railway clock — solid black hour + minute bars with flat
  // (square) ends, and the accent second hand: a thin stem ending in the
  // iconic disc (the dot is the tip — no stem protruding past it). No rounded
  // caps anywhere.
  function renderClockFace(showSeconds: boolean): ReturnType<typeof h> {
    const d = new Date()
    const within = d.getSeconds() * 1000 + d.getMilliseconds()
    const secondAngle = Math.min(within / 58500, 1) * 360
    const minuteAngle = d.getMinutes() * 6
    const hourAngle = (d.getHours() % 12) * 30 + d.getMinutes() * 0.5
    // A straight bar from a short tail behind the pivot to a flat (square) tip.
    const bar = (key: string, deg: number, len: number, tail: number, width: number, color: string): ReturnType<typeof h> => {
      const tip = along(deg, len, 0)
      const back = along(deg, -tail, 0)
      return h('line', { key, x1: back.x, y1: back.y, x2: tip.x, y2: tip.y, stroke: color, strokeWidth: width, strokeLinecap: 'butt' })
    }
    const secTail = pt(secondAngle + 180, 4)
    const secBall = pt(secondAngle, 35)
    return sbbDial(
      bar('hr', hourAngle, 29, 7, 5.4, INK),
      bar('min', minuteAngle, 43, 7, 4.4, INK),
      showSeconds &&
        h('line', {
          key: 'sec',
          x1: secTail.x,
          y1: secTail.y,
          x2: secBall.x,
          y2: secBall.y,
          stroke: ACCENT,
          strokeWidth: 1.4,
          strokeLinecap: 'butt'
        }),
      showSeconds && h('circle', { key: 'secball', cx: secBall.x, cy: secBall.y, r: 5, fill: ACCENT }),
      h('circle', { key: 'cap', cx: 50, cy: 50, r: 3.2, fill: INK })
    )
  }

  // Buttons ----------------------------------------------------------------
  const btn = (
    label: string,
    onClick: () => void,
    variant: 'primary' | 'secondary' = 'primary',
    disabled = false
  ): ReturnType<typeof h> =>
    h(
      'button',
      {
        onClick,
        disabled,
        className: `clock-btn${variant === 'primary' ? ' clock-btn--primary' : ''}`
      },
      label
    )
  // The handler receives the click so a glyph button can anchor a menu. The
  // glyph is a string for the plain text marks (⋯, ▶) and an `iconSvg` node
  // wherever the app's own stroke-icon idiom applies.
  const iconBtn = (
    label: string,
    glyph: string | ReturnType<typeof h>,
    onClick: (e: { clientX: number; clientY: number }) => void
  ): ReturnType<typeof h> =>
    h('button', { className: 'clock-icon-btn', onClick, 'aria-label': label, title: label }, glyph)

  /** Wall-clock time honouring the host's 12h/24h General setting. */
  const fmtWallTime = (d: Date, seconds: boolean, twelveHour: boolean): string => {
    if (!twelveHour) return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
    const h24 = d.getHours()
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12
    const suffix = h24 < 12 ? 'AM' : 'PM'
    return `${h12}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''} ${suffix}`
  }
  /** Same, for a bare hour/minute pair (alarm rows). */
  const fmtHourMinute = (hour: number, minute: number, twelveHour: boolean): string => {
    if (!twelveHour) return `${pad(hour)}:${pad(minute)}`
    const h12 = hour % 12 === 0 ? 12 : hour % 12
    return `${h12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`
  }

  // ---- Clock tab (analog face on top, world clock list below) ------------
  function renderClock(
    showSeconds: boolean,
    digitalMode: boolean,
    twelveHour: boolean,
    showWorld: boolean
  ): ReturnType<typeof h> {
    const d = new Date()
    const date = d.toLocaleDateString(api.ui.language(), { weekday: 'long', month: 'long', day: 'numeric' })
    const time = fmtWallTime(d, showSeconds, twelveHour)
    return h(
      'div',
      { className: 'clock-stack' },
      h(
        'div',
        { className: 'clock-center' },
        digitalMode
          ? digital(time, date)
          : h(
              'div',
              { className: 'clock-center', style: { gap: 'var(--space-2)' } },
              h('div', { className: 'clock-face' }, renderClockFace(showSeconds)),
              h('div', { className: 'clock-sub' }, `${time} · ${date}`)
            )
      ),
      showWorld && h('div', { key: 'world-divider', className: 'clock-divider' }),
      showWorld &&
        h(
          'div',
          { key: 'world-header', className: 'clock-header' },
          h('span', { className: 'clock-section-title' }, uiText('auto.6a968a7094fe')),
          h(
            'div',
            { className: 'clock-world-actions' },
            iconBtn(uiText('surface.worldSettings'), settingsIcon(), () => api.workspace.openOwnSettings('world')),
            worldAddSelect(true)
          )
        ),
      showWorld && worldList(true, false)
    )
  }

  // ---- World clock list --------------------------------------------------
  // The add-city search and the reorderable, day/night-tinted city list are
  // shared between the Clock tab and the settings World sub-section.

  /**
   * Type-to-filter city picker. A plain dropdown of the 30 curated cities was a
   * scroll with no way in but the eye, so the field filters on every keystroke
   * and Enter takes the top match. The list opens on focus (all remaining
   * cities) so browsing still works without typing, and the results overlay the
   * rows below rather than pushing them down — the compact instance sits in the
   * Clock tab's header, where a reflow would shove the whole world list.
   */
  const WorldSearch = ({ compact }: { compact?: boolean }): ReturnType<typeof h> => {
    const [query, setQuery] = React.useState('')
    const [open, setOpen] = React.useState(false)
    const q = query.trim()
    const available = CITIES.filter((c) => !store.state.worldCities.includes(cityId(c)))
    const matches = q ? available.filter((c) => cityMatches(c, q)) : available
    const label = uiText('auto.f0104616be3d')
    const add = (tz: string): void => {
      store.worldAdd(tz)
      setQuery('')
      setOpen(false)
    }
    const now = new Date()
    return h(
      'div',
      { className: `clock-citysearch${compact ? ' compact' : ''}` },
      h('input', {
        className: 'clock-input grow',
        type: 'text',
        value: query,
        placeholder: label,
        'aria-label': label,
        role: 'combobox',
        'aria-expanded': open,
        autoComplete: 'off',
        onFocus: () => setOpen(true),
        // A pick lands via the results' `onMouseDown` guard, so blur is only
        // ever a genuine move away from the field.
        onBlur: () => setOpen(false),
        onChange: (e: { target: { value: string } }) => {
          setQuery(e.target.value)
          setOpen(true)
        },
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === 'Enter' && matches[0]) {
            e.preventDefault()
            add(cityId(matches[0]))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            if (query) setQuery('')
            else setOpen(false)
          }
        }
      }),
      open &&
        h(
          'div',
          {
            key: 'results',
            className: 'clock-citysearch-results',
            // Keep focus in the input so the click that follows is not raced by
            // the blur that would otherwise unmount this list first.
            onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault()
          },
          matches.length === 0
            ? h('div', { className: 'clock-citysearch-empty' }, uiText('auto.15d57ca880c9'))
            : h(
                'div',
                { className: 'clock-citysearch-list' },
                ...matches.map((c) =>
                  h(
                    'button',
                    {
                      key: cityId(c),
                      type: 'button',
                      className: 'clock-citysearch-row',
                      'aria-label': uiText('auto.8fcf302b956a', { p0: c.name }),
                      onClick: () => add(cityId(c))
                    },
                    h('span', { className: 'clock-row-name' }, c.name),
                    h('span', { className: 'clock-sub' }, cityTime(c.tz, now, false, api.ui.language()))
                  )
                )
              )
        )
    )
  }
  const worldAddSelect = (compact = false): ReturnType<typeof h> =>
    h(WorldSearch, { key: compact ? 'compact' : 'full', compact })

  /** Whole-hour offset of `tz` from the local zone, as "+2 h" / "−5 h" / "" for
   *  the same offset. Read off the two wall-clock readings rather than a zone
   *  table, so DST on either side is already baked in. */
  const offsetLabel = (tz: string, date: Date): string => {
    const minutes = (zone?: string): number => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone ? cityZone(zone) : undefined,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
        .format(date)
        .split(':')
        .map((n) => parseInt(n, 10))
      return parts.length === 2 && parts.every(Number.isFinite) ? parts[0] * 60 + parts[1] : NaN
    }
    try {
      let diff = minutes(tz) - minutes()
      if (!Number.isFinite(diff)) return ''
      // Normalise the day wrap: the two readings can sit on either side of midnight.
      if (diff > 720) diff -= 1440
      if (diff < -720) diff += 1440
      if (diff === 0) return ''
      const sign = diff > 0 ? '+' : '−'
      const abs = Math.abs(diff)
      const hrs = Math.floor(abs / 60)
      const mins = abs % 60
      return `${sign}${hrs}${mins ? `:${pad(mins)}` : ''} h`
    } catch {
      return ''
    }
  }

  // Lucide-shaped marks for the world rows, so the list reads like the rest of
  // the app rather than like pasted text glyphs.
  const sunIcon = (): ReturnType<typeof h> =>
    iconSvg(
      h('circle', { key: 'c', cx: 12, cy: 12, r: 4 }),
      p('rays', 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41')
    )
  const moonIcon = (): ReturnType<typeof h> => iconSvg(p('m', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'))
  const closeIcon = (): ReturnType<typeof h> => iconSvg(p('x', 'M18 6 6 18'), p('x2', 'm6 6 12 12'))
  const settingsIcon = (): ReturnType<typeof h> => iconSvg(
    p('body', 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'),
    h('circle', { key: 'circle', cx: 12, cy: 12, r: 3 })
  )
  /** The app's `LuGripVertical` handle — two columns of three dots. */
  const gripIcon = (): ReturnType<typeof h> =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'currentColor',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' }
      },
      ...[5, 12, 19].flatMap((cy) => [
        h('circle', { key: `l${cy}`, cx: 9, cy, r: 1.5 }),
        h('circle', { key: `r${cy}`, cx: 15, cy, r: 1.5 })
      ])
    )

  type DragLike = {
    preventDefault: () => void
    dataTransfer?: { effectAllowed?: string; dropEffect?: string; setDragImage?: (image: Element, x: number, y: number) => void }
    clientX?: number
    clientY?: number
    currentTarget?: Element & { getBoundingClientRect: () => { top: number; height: number; left: number; width: number } }
  }
  const setIconDragImage = (source: Element | null | undefined, dataTransfer?: DragLike['dataTransfer']): void => {
    if (!source || !dataTransfer?.setDragImage) return
    const document = source.ownerDocument
    const image = document.createElement('div')
    image.className = 'clock-drag-ghost'
    image.appendChild(source.cloneNode(true))
    document.body.appendChild(image)
    dataTransfer.setDragImage(image, 12, 12)
    window.setTimeout(() => image.remove(), 0)
  }
  const endDrag = (): void => {
    if (store.state.worldDrag != null || store.state.worldDrop != null) {
      store.state.worldDrag = null
      store.state.worldDrop = null
      store.notify()
    }
  }
  const dropDestination = (from: number, target: number, after: boolean): number => {
    const insertion = after ? target + 1 : target
    return from < insertion ? insertion - 1 : insertion
  }
  // A full-width app list row: hairline-separated, hover-highlighted, with the
  // city over its offset line on the left and the time hard right. Day/night is
  // a stroke sun/moon in the app's icon idiom — no card, no tint, no pasted
  // text glyphs. Both surfaces reorder by drag (`drag`): the panel is where the
  // list is actually read, so sorting it there is the whole point.
  const worldRow = (tz: string, index: number, now: Date, drag: boolean, removable: boolean): ReturnType<typeof h> => {
    const day = isDaytime(tz, now)
    const dragging = drag && store.state.worldDrag === index
    const drop = drag && store.state.worldDrop?.index === index ? store.state.worldDrop : null
    const dnd = drag
      ? {
          draggable: true,
          onDragStart: (e: DragLike) => {
            store.state.worldDrag = index
            store.state.worldDrop = null
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            setIconDragImage(e.currentTarget?.querySelector('.clock-line-glyph svg'), e.dataTransfer)
            store.notify()
          },
          onDragOver: (e: DragLike) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget?.getBoundingClientRect()
            const after = rect && e.clientY != null ? e.clientY > rect.top + rect.height / 2 : false
            const current = store.state.worldDrop
            if (!current || current.index !== index || current.after !== after) {
              store.state.worldDrop = { index, after }
              store.notify()
            }
          },
          onDrop: (e: DragLike) => {
            e.preventDefault()
            const from = store.state.worldDrag
            const after = store.state.worldDrop?.after ?? false
            if (from != null && from !== index) store.worldMove(from, dropDestination(from, index, after))
            store.state.worldDrag = null
            store.state.worldDrop = null
            store.notify()
          },
          onDragEnd: endDrag
        }
      : {}
    return h(
      'div',
      {
        key: tz,
        onPointerDownCapture: () => { store.state.selectedCity = tz; store.notify() },
        className: `clock-line-row${drag ? ' draggable' : ''}${dragging ? ' dragging' : ''}${drop ? (drop.after ? ' drop-after' : ' drop-before') : ''}`,
        ...dnd
      },
      drag && removable && h('span', { key: 'grip', className: 'clock-grip', 'aria-hidden': true }, gripIcon()),
      h('span', { className: `clock-line-glyph${day ? '' : ' night'}`, 'aria-hidden': true }, day ? sunIcon() : moonIcon()),
      h(
        'div',
        { className: 'clock-row-main' },
        h('span', { className: 'clock-row-name' }, cityName(tz)),
        h('span', { className: 'clock-sub' }, [dayOffsetLabel(tz, now), offsetLabel(tz, now)].filter(Boolean).join(' · '))
      ),
      h('span', { className: 'clock-line-time' }, cityTime(tz, now, false, api.ui.language())),
      removable && iconBtn(uiText('auto.b8c425a1937d', { p0: cityName(tz) }), closeIcon(), () => void store.worldRemove(tz))
    )
  }
  const worldList = (drag: boolean, removable = true): ReturnType<typeof h> => {
    const now = new Date()
    return store.state.worldCities.length === 0
      ? h('div', { className: 'clock-empty' }, uiText('auto.cc44fe66b283'))
      : h(
          'div',
          { className: 'clock-list clock-list--flush' },
          ...store.state.worldCities.map((tz, i) => worldRow(tz, i, now, drag, removable))
        )
  }

  // ---- Alarm tab ---------------------------------------------------------
  // Localised at call time: the language can change without a re-register.
  const SOUND_LABEL: Record<AlarmSoundId, () => string> = {
    beep: () => uiText('auto.1973db095880'),
    chime: () => uiText('auto.3bb8c51f1c3b'),
    pulse: () => uiText('auto.b3cc660b9187'),
    radar: () => uiText('auto.aad82db2cb77'),
    bell: () => uiText('auto.d4198662a72f')
  }

  // Weekday names are derived from a week that starts on a known Sunday
  // (2024-01-07) so index 0 = Sunday lines up with `Date.getDay()`.
  const REF_SUNDAY = new Date(2024, 0, 7)
  const dayNames = (style: 'short' | 'narrow'): string[] =>
    Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(api.ui.language(), { weekday: style }).format(
        new Date(REF_SUNDAY.getFullYear(), REF_SUNDAY.getMonth(), REF_SUNDAY.getDate() + i)
      )
    )

  const alarmSwitch = (a: ClockAlarm): ReturnType<typeof h> =>
    h(
      'span',
      {
        className: `clock-switch ${a.enabled ? 'on' : ''}`,
        role: 'switch',
        'aria-checked': a.enabled,
        'aria-label': uiText('auto.b4c7a3d4504c', { p0: a.label || fmtHourMinute(a.hour, a.minute, false) }),
        tabIndex: 0,
        onClick: () => void store.toggleAlarm(a.id),
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            void store.toggleAlarm(a.id)
          }
        }
      },
      h('span', { className: 'clock-switch-knob' })
    )

  const alarmEditor = (a: ClockAlarm, weekStart: string, twelveHour: boolean): ReturnType<typeof h> => {
    const narrow = dayNames('narrow')
    const patch = (p: Partial<ClockAlarm>): void => void store.updateAlarm(a.id, p)
    const num = (
      label: string,
      value: number,
      min: number,
      max: number,
      onSet: (n: number) => void
    ): ReturnType<typeof h> =>
      h('input', {
        className: 'clock-input num',
        type: 'number',
        min,
        max,
        'aria-label': label,
        value: String(value),
        onChange: (e: { target: { value: string } }) => {
          const n = parseInt(e.target.value, 10)
          if (Number.isFinite(n)) onSet(Math.min(max, Math.max(min, n)))
        }
      })

    const hourField = twelveHour
      ? [
          num(uiText('auto.9e25a34e635a'), a.hour % 12 === 0 ? 12 : a.hour % 12, 1, 12, (n) => {
            const base = n % 12
            patch({ hour: a.hour < 12 ? base : base + 12 })
          }),
          h('span', { key: 'sep', className: 'clock-time-sep' }, ':'),
          num(uiText('auto.092f99ea11a3'), a.minute, 0, 59, (n) => patch({ minute: n })),
          h(SelectField, {
            key: 'ampm',
            className: 'clock-select',
            ariaLabel: 'AM/PM',
            value: a.hour < 12 ? 'am' : 'pm',
            onChange: (value: string) =>
              patch({ hour: value === 'am' ? a.hour % 12 : (a.hour % 12) + 12 }),
            options: [
              { value: 'am', label: 'AM' },
              { value: 'pm', label: 'PM' }
            ]
          })
        ]
      : [
          num(uiText('auto.9e25a34e635a'), a.hour, 0, 23, (n) => patch({ hour: n })),
          h('span', { key: 'sep', className: 'clock-time-sep' }, ':'),
          num(uiText('auto.092f99ea11a3'), a.minute, 0, 59, (n) => patch({ minute: n }))
        ]

    return h(
      'div',
      { className: 'clock-stack' },
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.6c82e6dd8680')),
        h('div', { className: 'clock-field-row' }, ...hourField)
      ),
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.74341e3c271d')),
        h('input', {
          className: 'clock-input grow',
          value: a.label,
          placeholder: uiText('auto.4c2b1c3a5e80'),
          'aria-label': uiText('auto.4c2b1c3a5e80'),
          onChange: (e: { target: { value: string } }) => patch({ label: e.target.value })
        })
      ),
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.659eba121958')),
        h(
          'div',
          { className: 'clock-days' },
          ...orderedWeekdays(weekStart).map((d) => {
            const on = a.days.includes(d)
            return h(
              'button',
              {
                key: d,
                className: `clock-day-btn${on ? ' on' : ''}`,
                'aria-pressed': on,
                'aria-label': dayNames('short')[d],
                title: dayNames('short')[d],
                onClick: () => patch({ days: on ? a.days.filter((x) => x !== d) : [...a.days, d] })
              },
              narrow[d]
            )
          })
        )
      ),
      // No date picker: an alarm with no repeat days means "the next time the
      // clock reads that time", which is what a one-shot alarm is for. A stored
      // `date` still resolves (`nextAlarmAt`) for records the CLI wrote — the
      // editor just does not ask for one.
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.b4e3efeba10e')),
        h(
          'div',
          { className: 'clock-field-row' },
          h(SelectField, {
            className: 'clock-select grow',
            value: a.sound,
            ariaLabel: uiText('auto.b4e3efeba10e'),
            onChange: (value: string) => patch({ sound: value as AlarmSoundId }),
            options: SOUND_IDS.map((id) => ({ value: id, label: SOUND_LABEL[id]() }))
          }),
          h(SoundPreview, { sound: a.sound })
        )
      ),
      // Delete moved into the row's ⋯ menu, so Done is the only action left.
      h(
        'div',
        { className: 'clock-btn-row clock-btn-row--fill' },
        btn(uiText('auto.e9b450d14bc2'), () => store.setAlarmEditing(null), 'primary')
      )
    )
  }

  const alarmRow = (a: ClockAlarm, index: number, weekStart: string, twelveHour: boolean): ReturnType<typeof h> => {
    const editing = store.state.alarmEditing === a.id
    const ringing = store.state.alarmRinging.includes(a.id)
    const summary = repeatLabel(a, weekStart, dayNames('short'))
    const dragging = store.state.alarmDrag === index
    const drop = store.state.alarmDrop?.index === index ? store.state.alarmDrop : null
    return h(
      'div',
      {
        key: a.id,
        draggable: true,
        className: `clock-row draggable${a.enabled ? '' : ' is-off'}${dragging ? ' dragging' : ''}${drop ? (drop.after ? ' drop-after' : ' drop-before') : ''}`,
        onDragStart: (e: DragLike) => {
          store.state.alarmDrag = index
          store.state.alarmDrop = null
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
          setIconDragImage(e.currentTarget?.querySelector('.clock-row-drag-icon svg'), e.dataTransfer)
          store.notify()
        },
        onDragOver: (e: DragLike) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget?.getBoundingClientRect()
          const after = rect && e.clientY != null ? e.clientY > rect.top + rect.height / 2 : false
          const current = store.state.alarmDrop
          if (!current || current.index !== index || current.after !== after) {
            store.state.alarmDrop = { index, after }
            store.notify()
          }
        },
        onDrop: (e: DragLike) => {
          e.preventDefault()
          const from = store.state.alarmDrag
          const after = store.state.alarmDrop?.after ?? false
          if (from != null && from !== index) store.alarmMove(from, dropDestination(from, index, after))
          store.state.alarmDrag = null
          store.state.alarmDrop = null
          store.notify()
        },
        onDragEnd: () => {
          store.state.alarmDrag = null
          store.state.alarmDrop = null
          store.notify()
        }
      },
      h('span', { className: 'clock-row-drag-icon', 'aria-hidden': true }, tabIcon.alarm()),
      h(
        'div',
        { className: 'clock-row-top' },
        h(
          'div',
          { className: 'clock-row-main' },
          h('span', { className: 'clock-readout md' }, fmtHourMinute(a.hour, a.minute, twelveHour)),
          h('span', { className: 'clock-sub' }, a.label ? `${a.label} · ${summary}` : summary)
        ),
        alarmSwitch(a),
        // Edit + Delete live in one ⋯ menu rather than a chevron plus a button
        // inside the editor (shared host menu, so it clamps to the viewport).
        iconBtn(uiText('auto.86c0a35ec883'), '⋯', (e) => {
          void api.ui.openMenu(
            [
              {
                label: uiText('auto.5301648dcf6b'),
                icon: editMenuIcon(),
                onSelect: () => store.setAlarmEditing(editing ? null : a.id)
              },
              {
                label: uiText('auto.f6fdbe48dc54'),
                icon: trashMenuIcon(),
                danger: true,
                onSelect: () => void store.removeAlarm(a.id)
              }
            ],
            { x: e.clientX, y: e.clientY }
          )
        })
      ),
      ringing &&
        h(
          'div',
          { key: 'ring', className: 'clock-btn-row' },
          h('span', { className: 'clock-chip static' }, uiText('auto.81b62ad785bb')),
          btn(uiText('auto.e2b51688f4b0'), () => store.snoozeAlarm(a.id), 'secondary'),
          btn(uiText('auto.70afe9eff3f2'), () => store.dismissAlarm(a.id), 'primary')
        ),
      editing && alarmEditor(a, weekStart, twelveHour)
    )
  }

  function renderAlarms(weekStart: string, twelveHour: boolean): ReturnType<typeof h> {
    const alarms = store.state.alarms
    return h(
      'div',
      { className: 'clock-stack' },
      h(
        'div',
        { className: 'clock-header' },
        h('span', { className: 'clock-section-title' }, uiText('auto.25f8c55de811')),
        btn(uiText('auto.a63bb1d9ec04'), () => {
          const a = store.addAlarm()
          store.setAlarmEditing(a.id)
        }, 'primary')
      ),
      alarms.length === 0
        ? h('div', { className: 'clock-empty' }, uiText('auto.c144a21d5a16'))
        : h('div', { className: 'clock-list' }, ...alarms.map((a, index) => alarmRow(a, index, weekStart, twelveHour)))
    )
  }

  // ---- Stopwatch tab -----------------------------------------------------
  function renderStopwatch(digitalMode: boolean): ReturnType<typeof h> {
    const ms = store.swElapsed()
    const running = store.state.sw.running
    const secAngle = ((ms / 1000) % 60) * 6
    const minAngle = (Math.floor(ms / 60000) % 60) * 6
    const secTip = pt(secAngle, 42)
    const secTail = pt(secAngle + 180, 11)
    const face = digitalMode
      ? digital(fmtStopwatch(ms))
      : h(
          'div',
          { className: 'clock-face-stack' },
          sbbDial(
            hand('min', minAngle, 26, 9, 1.35, 4),
            h('line', { key: 'sec', x1: secTail.x, y1: secTail.y, x2: secTip.x, y2: secTip.y, stroke: ACCENT, strokeWidth: 1, strokeLinecap: 'butt' }),
            h('circle', { key: 'cap', cx: 50, cy: 50, r: 3.2, fill: ACCENT })
          ),
          h('div', { className: 'clock-face-caption clock-readout sm' }, fmtStopwatch(ms))
        )
    return h(
      'div',
      { className: 'clock-center' },
      face,
      h(
        'div',
        { className: 'clock-btn-row clock-btn-row--fill' },
        btn(running ? uiText('auto.e3abd1b61219') : uiText('auto.44c57abd888a'), running ? store.swLap : store.swReset, 'secondary'),
        btn(running ? uiText('auto.9e253470c876') : uiText('auto.952f375412e8'), running ? store.swStop : store.swStart, 'primary')
      ),
      store.state.sw.laps.length > 0 &&
        h(
          'div',
          { key: 'laps', className: 'clock-laps' },
          ...store.state.sw.laps.map((cumulative, i) => {
            const older = store.state.sw.laps[i + 1] ?? 0
            const n = store.state.sw.laps.length - i
            return h(
              'div',
              { key: `lap${n}`, className: 'clock-lap' },
              h('span', null, uiText('auto.a6e47c5b825f', { p0: n })),
              h('span', null, fmtStopwatch(cumulative - older))
            )
          })
        )
    )
  }

  // ---- Timer tab ---------------------------------------------------------
  // One hh : mm : ss group under a single "Duration" label — the same shape as
  // the alarm Time field. The per-box captions live on as `aria-label`s.
  const durationBox = (label: string, value: number, max: number, onChange: (v: number) => void): ReturnType<typeof h> =>
    h('input', {
      key: label,
      className: 'clock-input num',
      type: 'number',
      min: 0,
      max,
      'aria-label': label,
      value: String(value),
      onChange: (e: { target: { value: string } }) => {
        const n = parseInt(e.target.value, 10)
        onChange(Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0)
      }
    })

  // Timers are digital only — an analog dial has no room for a label, and a
  // countdown reads faster as digits with a depleting bar under them.
  function renderTimer(presetLabels: string[]): ReturnType<typeof h> {
    // Settings → Timer owns this row: up to five chips, and none at all when
    // the user has cleared the list. The labels arrive from `Panel`'s single
    // settings read — a `settings.get()` of our own would be the second one per
    // render this panel is not allowed to make.
    const presets: [string, number][] = presetLabels.map((label) => [label, parseDuration(label)])
    const pick = store.state.pick
    const total = pick.h * 3600 + pick.m * 60 + pick.s
    const sep = (key: string): ReturnType<typeof h> => h('span', { key, className: 'clock-time-sep' }, ':')
    const adder = h(
      'div',
      { className: 'clock-form' },
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.1370004da76f')),
        h(
          'div',
          { className: 'clock-field-row' },
          durationBox(uiText('auto.9e25a34e635a'), pick.h, 23, (v) => {
            pick.h = v
            store.notify()
          }),
          sep('s1'),
          durationBox(uiText('auto.092f99ea11a3'), pick.m, 59, (v) => {
            pick.m = v
            store.notify()
          }),
          sep('s2'),
          durationBox(uiText('auto.5fb1db527825'), pick.s, 59, (v) => {
            pick.s = v
            store.notify()
          })
        )
      ),
      h(
        'div',
        { className: 'clock-field' },
        h('span', { className: 'clock-field-label' }, uiText('auto.709a23220f2c')),
        h('input', {
          className: 'clock-input grow',
          value: pick.label,
          placeholder: uiText('auto.6b336ccec146'),
          'aria-label': uiText('auto.709a23220f2c'),
          onChange: (e: { target: { value: string } }) => {
            pick.label = e.target.value
            store.notify()
          }
        })
      ),
      presets.length > 0 &&
        h(
          'div',
          { key: 'presets', className: 'clock-preset-row' },
          ...presets.map(([label, secs]) =>
            h(
              'button',
              {
                key: label,
                className: 'clock-chip',
                onClick: () => {
                  store.addTimer(secs, pick.label)
                  pick.label = ''
                  store.notify()
                }
              },
              label
            )
          )
        ),
      h(
        'div',
        { className: 'clock-btn-row clock-btn-row--fill' },
        btn(uiText('auto.82ceb7578e8c'), () => {
          if (store.addTimer(total, pick.label)) {
            pick.h = 0
            pick.m = 5
            pick.s = 0
            pick.label = ''
          }
        }, 'primary', total === 0)
      )
    )

    // A running timer is a full-width band: countdown and label on the left, its
    // two actions on the right, and the remaining fraction as a hairline bar
    // across the bottom — the width the panel actually has, spent on the row.
    const card = (t: ClockTimer, index: number): ReturnType<typeof h> => {
      const remaining = store.timerRemaining(t)
      const done = remaining === 0 && !t.running
      const frac = t.duration > 0 ? Math.min(1, Math.max(0, remaining / t.duration)) : 0
      const title = t.label.trim() || uiText('auto.9d9cec22f36f')
      const duration = fmtPresetLabel(Math.round(t.duration / 1000))
      const dragging = store.state.timerDrag === index
      const drop = store.state.timerDrop?.index === index ? store.state.timerDrop : null
      return h(
        'div',
        {
          key: t.id,
          draggable: true,
          onPointerDownCapture: () => { store.state.selectedTimer = t.id; store.notify() },
          className: `clock-card draggable${done ? ' is-done' : ''}${t.running ? '' : ' is-paused'}${dragging ? ' dragging' : ''}${drop ? (drop.after ? ' drop-after' : ' drop-before') : ''}`,
          onDragStart: (e: DragLike) => {
            store.state.timerDrag = index
            store.state.timerDrop = null
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            setIconDragImage(e.currentTarget?.querySelector('.clock-row-drag-icon svg'), e.dataTransfer)
            store.notify()
          },
          onDragOver: (e: DragLike) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget?.getBoundingClientRect()
            const after = rect && e.clientY != null ? e.clientY > rect.top + rect.height / 2 : false
            const current = store.state.timerDrop
            if (!current || current.index !== index || current.after !== after) {
              store.state.timerDrop = { index, after }
              store.notify()
            }
          },
          onDrop: (e: DragLike) => {
            e.preventDefault()
            const from = store.state.timerDrag
            const after = store.state.timerDrop?.after ?? false
            if (from != null && from !== index) store.timerMove(from, dropDestination(from, index, after))
            store.state.timerDrag = null
            store.state.timerDrop = null
            store.notify()
          },
          onDragEnd: () => {
            store.state.timerDrag = null
            store.state.timerDrop = null
            store.notify()
          }
        },
        h('span', { className: 'clock-row-drag-icon', 'aria-hidden': true }, tabIcon.timer()),
        h(
          'div',
          { className: 'clock-card-top' },
          h(
            'div',
            { className: 'clock-row-main' },
            h('div', { className: `clock-readout md${done ? ' done' : ''}` }, fmtCountdown(remaining)),
            h(
              'div',
              { className: 'clock-timer-meta clock-sub' },
              h('span', { className: 'clock-timer-title' }, title),
              h('span', { className: 'clock-timer-duration' }, duration),
              !t.running && !done && h('span', { className: 'clock-timer-state' }, uiText('auto.60c22504e298'))
            )
          ),
          h(
            'div',
            { className: 'clock-card-actions' },
            done
              ? btn(uiText('auto.e9b450d14bc2'), () => store.cancelTimer(t.id), 'primary')
              : t.running
                ? btn(uiText('auto.781961bc81c2'), () => store.pauseTimer(t.id), 'primary')
                : btn(uiText('auto.b3bd0b5a7049'), () => store.resumeTimer(t.id), 'primary'),
            iconBtn(uiText('auto.77dfd2135f4d'), closeIcon(), () => void store.cancelTimer(t.id))
          )
        ),
        h(
          'div',
          { className: 'clock-progress', role: 'presentation' },
          h('div', { className: 'clock-progress-fill', style: { width: `${frac * 100}%` } })
        )
      )
    }

    // The adder leads: setting a timer is what the tab is for, and it must not
    // slide down the panel as running timers pile up above it.
    return h(
      'div',
      { className: 'clock-stack' },
      adder,
      store.state.timers.length > 0 &&
        h('div', { key: 'running', className: 'clock-list' }, ...store.state.timers.map(card))
    )
  }

  // ---- Pomodoro tab ------------------------------------------------------
  const PomodoroPanel = (): ReturnType<typeof h> => {
    const [pickerOpen, setPickerOpen] = React.useState(false)
    const phase = store.state.pomo
    const c = store.pomoConfig()
    const remaining = store.pomoRemaining()
    const active = store.pomoProfiles().find((profile) => profile.id === store.state.pomoProfileId)
    const activeName = active?.name || uiText('auto.fe7f55b8bf68')
    const total = (phase.phase === 'work' ? c.work : phase.phase === 'short' ? c.short : c.long) * 60000
    const frac = total > 0 ? remaining / total : 0
    const plusIcon = (): ReturnType<typeof h> => iconSvg(p('v', 'M12 5v14'), p('h', 'M5 12h14'))
    const modal = pickerOpen && h(
      api.ui.Modal,
      {
        title: uiText('surface.pomodoroSelect'),
        size: 'small',
        bodyClassName: 'pomo-picker-modal-body',
        onClose: () => setPickerOpen(false),
        headerActions: h(
          'div',
          { className: 'pomo-panel-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'clock-icon-btn',
              'aria-label': uiText('surface.pomodoroSettings'),
              title: uiText('surface.pomodoroSettings'),
              onClick: () => {
                setPickerOpen(false)
                api.workspace.openOwnSettings('pomodoro')
              }
            },
            settingsIcon()
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'clock-icon-btn',
              'aria-label': uiText('surface.pomodoroNew'),
              title: uiText('surface.pomodoroNew'),
              onClick: () => {
                const profile = store.addPomoProfile()
                store.state.pomoSettingsProfileId = profile.id
                setPickerOpen(false)
                api.workspace.openOwnSettings('pomodoro')
              }
            },
            plusIcon()
          )
        )
      },
      h(
        'div',
        { className: 'pomo-picker-list' },
        ...store.pomoProfiles().map((profile) => h(
          'button',
          {
            key: profile.id,
            type: 'button',
            className: `pomo-picker-row${profile.id === store.state.pomoProfileId ? ' active' : ''}`,
            onClick: () => {
              store.selectPomoProfile(profile.id)
              setPickerOpen(false)
            }
          },
          h('span', { className: 'pomo-picker-icon', 'aria-hidden': true }, tabIcon.pomodoro()),
          h(
            'span',
            { className: 'pomo-picker-meta' },
            h('span', { className: 'pomo-picker-name' }, profile.name || uiText('auto.fe7f55b8bf68')),
            h('span', { className: 'pomo-picker-summary' }, uiText('surface.pomodoroSummary', { work: profile.work, short: profile.short, long: profile.long, cycles: profile.cycles }))
          ),
          profile.id === store.state.pomoProfileId && h('span', { className: 'pomo-picker-check', 'aria-hidden': true }, '✓')
        ))
      )
    )
    return h(
      React.Fragment,
      null,
      h(
        'div',
        { className: 'clock-center' },
        h(
          'button',
          {
            type: 'button',
            className: 'clock-chip pomo-profile-chip',
            'aria-haspopup': 'dialog',
            'aria-label': uiText('surface.pomodoroSelect'),
            onClick: () => setPickerOpen(true)
          },
          activeName
        ),
        h(
          'div',
          { className: 'clock-face-stack', style: { maxWidth: '180px' } },
          h(
            'svg',
            { viewBox: '0 0 100 100', width: '100%', height: '100%', style: { display: 'block', transform: 'rotate(-90deg)' } },
            h('circle', { cx: 50, cy: 50, r: 44, fill: 'none', stroke: 'var(--border-light)', strokeWidth: 6 }),
            h('circle', {
              cx: 50,
              cy: 50,
              r: 44,
              fill: 'none',
              stroke: ACCENT,
              strokeWidth: 6,
              strokeLinecap: 'butt',
              strokeDasharray: 2 * Math.PI * 44,
              strokeDashoffset: 2 * Math.PI * 44 * (1 - frac)
            })
          ),
          h(
            'div',
            { className: 'clock-face-overlay' },
            h('div', { className: 'clock-readout' }, fmtCountdown(remaining)),
            h('div', { className: 'clock-sub' }, uiText('auto.3db229724cfd', { p0: phase.cycle + (phase.phase === 'work' ? 1 : 0), p1: c.cycles }))
          )
        ),
        h(
          'div',
          { className: 'clock-btn-row clock-btn-row--fill' },
          btn(uiText('auto.44c57abd888a'), store.pomoReset, 'secondary'),
          phase.running ? btn(uiText('auto.781961bc81c2'), store.pomoPause, 'primary') : btn(uiText('auto.952f375412e8'), store.pomoStart, 'primary'),
          btn(uiText('auto.3da474537ac3'), store.pomoSkip, 'secondary')
        )
      ),
      modal
    )
  }
  function renderPomodoro(): ReturnType<typeof h> { return h(PomodoroPanel) }

  // ---- Panel -------------------------------------------------------------
  const useStore = (): void => {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const render = (): void => force((n) => n + 1)
      const FRAME_MS = 1000 / 30
      let raf = 0
      let last = 0
      const animating = (): boolean =>
        clockNeedsAnimation(
          {
            mode: store.state.mode,
            swRunning: store.state.sw.running,
            anyTimerRunning: store.state.timers.some((t) => t.running),
            pomoRunning: store.state.pomo.running
          },
          document.hidden
        )
      const step = (t: number): void => {
        if (t - last >= FRAME_MS) {
          last = t
          render()
        }
        raf = animating() ? window.requestAnimationFrame(step) : 0
      }
      const kick = (): void => {
        if (!raf && animating()) {
          last = 0
          raf = window.requestAnimationFrame(step)
        }
      }
      const onNotify = (): void => {
        render()
        kick()
      }
      const off = store.subscribe(onNotify)
      document.addEventListener('visibilitychange', kick)
      kick()
      return () => {
        off()
        document.removeEventListener('visibilitychange', kick)
        if (raf) window.cancelAnimationFrame(raf)
      }
    }, [])
  }

  /** Host General settings (week start, 12/24 h) — a stable snapshot, so this
   *  subscription never costs a render on unrelated state changes. */
  const useHostState = (): { weekStart: string; timeFormat: '24h' | '12h' } =>
    React.useSyncExternalStore(api.subscribe, api.getState, api.getState)

  const Panel = (): ReturnType<typeof h> => {
    useStore()
    const { weekStart, timeFormat } = useHostState()
    // Read settings once per render — display faces are settings-driven.
    const s = api.settings.get()
    const showSeconds = s.seconds !== false
    const twelveHour = timeFormat === '12h'
    // The store coerces the mode when a view is switched off, but a `clock:mode`
    // command can still name a hidden tab — resolve here too.
    const modes = orderedModes(visibleModes(s), store.state.tabOrder)
    const mode = modes.includes(store.state.mode) ? store.state.mode : 'clock'

    // The strip reorders by drag, like the world list and the app's own rails:
    // no grip glyph — a 26px icon button *is* the handle.
    const endTabDrag = (): void => {
      if (store.state.tabDrag != null || store.state.tabDrop != null) {
        store.state.tabDrag = null
        store.state.tabDrop = null
        store.notify()
      }
    }
    const seg = (key: Mode, label: string, index: number): ReturnType<typeof h> => {
      const on = mode === key
      const drop = store.state.tabDrop?.index === index ? store.state.tabDrop : null
      return h(
        'button',
        {
          key,
          role: 'tab',
          'aria-selected': on,
          'aria-label': label,
          title: label,
          className: `clock-tab${on ? ' active' : ''}${store.state.tabDrag === index ? ' dragging' : ''}${drop ? (drop.after ? ' drop-after' : ' drop-before') : ''}`,
          onClick: () => store.setMode(key),
          draggable: true,
          onDragStart: (e: DragLike) => {
            store.state.tabDrag = index
            store.state.tabDrop = null
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            setIconDragImage(e.currentTarget?.querySelector('svg'), e.dataTransfer)
            store.notify()
          },
          onDragOver: (e: DragLike) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget?.getBoundingClientRect()
            const after = rect && e.clientX != null ? e.clientX > rect.left + rect.width / 2 : false
            const current = store.state.tabDrop
            if (!current || current.index !== index || current.after !== after) {
              store.state.tabDrop = { index, after }
              store.notify()
            }
          },
          onDrop: (e: DragLike) => {
            e.preventDefault()
            const from = store.state.tabDrag
            store.state.tabDrag = null
            const after = store.state.tabDrop?.after ?? false
            store.state.tabDrop = null
            if (from != null && from !== index) store.setTabOrder(reorder(modes, from, dropDestination(from, index, after)))
            else store.notify()
          },
          onDragEnd: endTabDrag
        },
        tabIcon[key]()
      )
    }

    let body: ReturnType<typeof h>
    switch (mode) {
      case 'alarm':
        body = renderAlarms(weekStart, twelveHour)
        break
      case 'stopwatch':
        body = renderStopwatch(s.stopwatchDisplay === 'digital')
        break
      case 'timer':
        body = renderTimer(timerPresets(s))
        break
      case 'pomodoro':
        body = renderPomodoro()
        break
      default:
        body = renderClock(showSeconds, s.clockDisplay === 'digital', twelveHour, viewEnabled('world', s))
    }

    const TAB_LABEL: Record<Mode, () => string> = {
      clock: () => uiText('auto.04f6b3ea183e'),
      alarm: () => uiText('auto.25f8c55de811'),
      stopwatch: () => uiText('auto.15bd6cc6511c'),
      timer: () => uiText('auto.9d9cec22f36f'),
      pomodoro: () => uiText('auto.212e4618d030')
    }

    return h(
      'div',
      { className: 'clock-panel' },
      // A single remaining tab is no choice at all — drop the strip entirely.
      modes.length > 1 &&
        h(
          'div',
          { key: 'tabs', role: 'tablist', 'aria-label': uiText('auto.3286a93a040f'), className: 'clock-tabs' },
          ...modes.map((m, i) => seg(m, TAB_LABEL[m](), i))
        ),
      h('div', { className: 'clock-body' }, body)
    )
  }

  // ---- Settings view (5 sub-sections) ------------------------------------
  // Rendered inside the core Settings modal (`<section class="settings-section">`),
  // so it reuses the shared settings row/switch CSS for a native look. The active
  // sub-section arrives as the `section` prop (see manifest `settingsSections`).
  const SettingsView = ({ section }: { section?: string }): ReturnType<typeof h> => {
    const sec = section || 'clock'
    const [, force] = React.useState(0)
    const [pomoDetail, setPomoDetail] = React.useState<string | null>(() =>
      sec === 'pomodoro' ? store.state.pomoSettingsProfileId : null
    )
    React.useEffect(() => {
      const rerender = (): void => force((n) => n + 1)
      const off = store.subscribe(rerender)
      const offSettings = api.settings.subscribe(rerender)
      // Only the World list shows live times — tick just for it.
      const iv = sec === 'world' ? window.setInterval(rerender, 1000) : 0
      return () => {
        off()
        offSettings()
        if (iv) window.clearInterval(iv)
      }
    }, [sec])
    React.useEffect(() => {
      if (sec !== 'pomodoro') {
        setPomoDetail(null)
        return
      }
      if (store.state.pomoSettingsProfileId) {
        setPomoDetail(store.state.pomoSettingsProfileId)
        store.state.pomoSettingsProfileId = null
      }
    }, [sec])
    const s = api.settings.get()
    const set = (key: string, value: unknown): void => {
      const pomoKeys: Record<string, keyof PomoConfig> = {
        pomodoroWork: 'work',
        pomodoroShort: 'short',
        pomodoroLong: 'long',
        pomodoroCycles: 'cycles'
      }
      const pomoKey = pomoKeys[key]
      if (sec === 'pomodoro' && pomoKey && typeof value === 'number') {
        store.updatePomoProfile(store.state.pomoProfileId, { [pomoKey]: value })
        return
      }
      void api.settings.set(key, value)
    }

    const { Row, Toggle, SelectField, NumberField, ChipsField, TextField, Button } = api.ui.settings
    const row = (label: string, desc: string | undefined, control: ReturnType<typeof h>): ReturnType<typeof h> =>
      h(Row, { title: label, ...(desc ? { description: desc } : {}) }, control)
    const switchEl = (on: boolean, onChange: (v: boolean) => void, label: string): ReturnType<typeof h> =>
      h(Toggle, { checked: on, onChange, label })
    const toggleRow = (label: string, desc: string, key: string): ReturnType<typeof h> => {
      // All clock toggles default on, so absence reads as enabled.
      const on = s[key] !== false
      return row(label, desc, switchEl(on, (v) => set(key, v), label))
    }
    const displayRow = (label: string, desc: string, key: string): ReturnType<typeof h> => {
      const value = s[key] === 'digital' ? 'digital' : 'analog'
      return row(
        label,
        desc,
        h(SelectField, {
          value,
          ariaLabel: label,
          onChange: (next: string) => set(key, next),
          options: [
            { value: 'analog', label: uiText('auto.830bf70f56c5') },
            { value: 'digital', label: uiText('auto.bbe5befacfed') }
          ]
        })
      )
    }
    const selectRow = (
      label: string,
      desc: string | undefined,
      key: string,
      options: { value: string; label: string }[],
      dflt: string
    ): ReturnType<typeof h> =>
      row(
        label,
        desc,
        h(SelectField, {
          value: typeof s[key] === 'string' ? String(s[key]) : dflt,
          ariaLabel: label,
          onChange: (next: string) => set(key, next),
          options
        })
      )
    const numberRow = (label: string, key: string, dflt: number): ReturnType<typeof h> =>
      row(
        label,
        undefined,
        h(NumberField, {
          min: 1,
          value: Number(s[key]) > 0 ? Number(s[key]) : dflt,
          allowEmpty: true,
          ariaLabel: label,
          onChange: (next: number | null) => set(key, next ?? undefined)
        })
      )

    if (sec === 'world') {
      return h(
        'div',
        { className: 'clock-world-settings', style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' } },
        h(
          'span',
          { className: 'settings-empty-text', style: { marginBottom: '2px' } },
          uiText('auto.3fde460125d8')
        ),
        worldAddSelect(),
        worldList(true)
      )
    }

    if (sec === 'alarm') {
      return h(
        'div',
        { style: { width: '100%' } },
        selectRow(
          uiText('auto.816c0ceb45b0'),
          uiText('auto.2193e49f6961'),
          'alarmSound',
          SOUND_IDS.map((id) => ({ value: id, label: SOUND_LABEL[id]() })),
          'beep'
        ),
        numberRow(uiText('auto.d913b34a7c13'), 'alarmSnooze', 9)
      )
    }
    if (sec === 'stopwatch') {
      return h('div', { style: { width: '100%' } }, displayRow(uiText('auto.0be9b9c95c84'), uiText('auto.e6e7c33b16bd'), 'stopwatchDisplay'))
    }
    if (sec === 'timer') {
      // Settings configures the tab, it does not run it: the adder and the
      // live list belong to the panel, and duplicating them here only gave the
      // user a second, half-featured Timer. What is left is the one thing the
      // panel cannot offer — which quick durations its chip row holds.
      const presets = timerPresets(s)
      const title = uiText('auto.79c10c38e47a')
      return h(
        'div',
        { style: { width: '100%' } },
        row(
          title,
          uiText('auto.e5fb71d3a486', { p0: TIMER_PRESET_LIMIT }),
          h(ChipsField, {
            items: presets,
            ariaLabel: title,
            placeholder: '10m',
            reorderable: true,
            // A parseable draft becomes its canonical label ("90s" → "1m30s")
            // so the chip and the panel's button read the same; anything else
            // survives verbatim for `validate` to reject with a reason.
            normalize: (value: string) => fmtPresetLabel(parseDuration(value)) || value.trim(),
            validate: (value: string, items: readonly string[]) => {
              if (parseDuration(value) <= 0) return uiText('auto.f55f1dcb0b3d')
              // Never disable the field at the limit — that would grey out the
              // chips' own remove buttons and strand the user at five.
              if (items.length >= TIMER_PRESET_LIMIT) return uiText('auto.efb57a5f4f04', { p0: TIMER_PRESET_LIMIT })
              return true
            },
            onChange: (items: string[]) => set('timerPresets', JSON.stringify(items.slice(0, TIMER_PRESET_LIMIT)))
          })
        )
      )
    }
    if (sec === 'pomodoro') {
      const profiles = store.pomoProfiles()
      const selected = profiles.find((profile) => profile.id === pomoDetail)
      const profileName = (profile: PomodoroProfile): string => profile.name || uiText('auto.fe7f55b8bf68')
      const profileSummary = (profile: PomodoroProfile): string => uiText('surface.pomodoroSummary', {
        work: profile.work,
        short: profile.short,
        long: profile.long,
        cycles: profile.cycles
      })
      if (selected) {
        const profileNumberRow = (label: string, key: keyof PomoConfig): ReturnType<typeof h> =>
          row(
            label,
            undefined,
            h(NumberField, {
              min: 1,
              value: selected[key],
              allowEmpty: true,
              ariaLabel: label,
              onChange: (value: number | null) => {
                if (value !== null) store.updatePomoProfile(selected.id, { [key]: value })
              }
            })
          )
        return h(
          'div',
          { className: 'settings-section settings-listpage clock-pomodoro-settings' },
          h(
            'div',
            { className: 'settings-listpage-crumbs' },
            h(
              'button',
              {
                type: 'button',
                className: 'settings-listpage-back',
                'aria-label': uiText('auto.77dfd2135f4d'),
                onClick: () => setPomoDetail(null)
              },
              '‹'
            ),
            h('span', { className: 'settings-list-name' }, profileName(selected))
          ),
          row(
            uiText('auto.709a23220f2c'),
            undefined,
            h(TextField, {
              value: selected.name,
              placeholder: uiText('auto.fe7f55b8bf68'),
              ariaLabel: uiText('auto.709a23220f2c'),
              onChange: (value: string) => store.renamePomoProfile(selected.id, value),
              onCommit: (value: string) => store.renamePomoProfile(selected.id, value, true)
            })
          ),
          profileNumberRow(uiText('auto.2b3d1c34c35f'), 'work'),
          profileNumberRow(uiText('auto.26d345c90583'), 'short'),
          profileNumberRow(uiText('auto.abed5549bdb9'), 'long'),
          profileNumberRow(uiText('auto.5075a58d4e4a'), 'cycles'),
          profiles.length > 1 && h(
            'div',
            { className: 'settings-row-actions' },
            h(
              Button,
              {
                className: 'settings-button settings-button--danger',
                onClick: () => {
                  store.removePomoProfile(selected.id)
                  setPomoDetail(null)
                }
              },
              uiText('surface.pomodoroRemove')
            )
          )
        )
      }
      return h(
        'div',
        { className: 'settings-section settings-listpage clock-pomodoro-settings' },
        h(
          'div',
          { className: 'settings-listpage-header' },
          h('h4', { className: 'settings-label' }, uiText('auto.212e4618d030')),
          h(
            Button,
            {
              className: 'settings-listpage-add settings-button settings-button--small',
              'aria-label': uiText('surface.pomodoroAdd'),
              title: uiText('surface.pomodoroAdd'),
              onClick: () => store.addPomoProfile()
            },
            '+'
          )
        ),
        h(
          'div',
          { className: 'settings-list' },
          ...profiles.map((profile, index) => {
            const dragging = store.state.pomoProfileDrag === index
            const drop = store.state.pomoProfileDrop?.index === index ? store.state.pomoProfileDrop : null
            return h(
              'button',
              {
                key: profile.id,
                type: 'button',
                draggable: true,
                className: 'settings-list-row',
                'data-reorder-active': dragging ? 'true' : undefined,
                'data-drop-position': drop ? (drop.after ? 'after' : 'before') : undefined,
                onClick: () => {
                  store.selectPomoProfile(profile.id)
                  setPomoDetail(profile.id)
                },
                onDragStart: (e: DragLike) => {
                  store.state.pomoProfileDrag = index
                  store.state.pomoProfileDrop = null
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                  setIconDragImage(e.currentTarget?.querySelector('.settings-list-glyph svg'), e.dataTransfer)
                  store.notify()
                },
                onDragOver: (e: DragLike) => {
                  e.preventDefault()
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget?.getBoundingClientRect()
                  const after = rect && e.clientY != null ? e.clientY > rect.top + rect.height / 2 : false
                  const current = store.state.pomoProfileDrop
                  if (!current || current.index !== index || current.after !== after) {
                    store.state.pomoProfileDrop = { index, after }
                    store.notify()
                  }
                },
                onDrop: (e: DragLike) => {
                  e.preventDefault()
                  const from = store.state.pomoProfileDrag
                  const after = store.state.pomoProfileDrop?.after ?? false
                  if (from != null && from !== index) store.pomoProfileMove(from, dropDestination(from, index, after))
                  store.state.pomoProfileDrag = null
                  store.state.pomoProfileDrop = null
                  store.notify()
                },
                onDragEnd: () => {
                  store.state.pomoProfileDrag = null
                  store.state.pomoProfileDrop = null
                  store.notify()
                }
              },
              h('span', { className: 'settings-list-glyph', 'aria-hidden': true }, tabIcon.pomodoro()),
              h(
                'span',
                { className: 'settings-list-meta' },
                h('span', { className: 'settings-list-name' }, profileName(profile)),
                h('span', { className: 'settings-list-sub' }, profileSummary(profile))
              ),
              h('span', { className: 'settings-list-chevron', 'aria-hidden': true }, '›')
            )
          })
        )
      )
    }
    // Default: Clock — the plugin's root page, which also carries the five
    // view switches (the shape Assistant uses for Telegram / WhatsApp).
    const VIEW_ROWS: [ClockView, string, string][] = [
      ['world', uiText('auto.6a968a7094fe'), uiText('auto.2a8a7da69f8f')],
      ['alarm', uiText('auto.25f8c55de811'), uiText('auto.a0fd69ac917c')],
      ['stopwatch', uiText('auto.15bd6cc6511c'), uiText('auto.d8127bcecbf4')],
      ['timer', uiText('auto.9d9cec22f36f'), uiText('auto.e2b64297512f')],
      ['pomodoro', uiText('auto.212e4618d030'), uiText('auto.5b9be3e4f35a')]
    ]
    return h(
      'div',
      { style: { width: '100%' } },
      displayRow(uiText('auto.0bb80737096b'), uiText('auto.28ec48330176'), 'clockDisplay'),
      toggleRow(uiText('auto.f7172f2029ed'), uiText('auto.e4608fde30c3'), 'seconds'),
      toggleRow(uiText('auto.8a0bf5876aaf'), uiText('auto.9b4c3ee037ea'), 'footerTime'),
      toggleRow(uiText('auto.aaa7a6f89cdb'), uiText('auto.36882bb3a7cd'), 'footerSeconds'),
      h('h4', { key: 'views', className: 'settings-label clock-settings-label' }, uiText('auto.3286a93a040f')),
      ...VIEW_ROWS.map(([view, label, desc]) => {
        const key = VIEW_SETTING[view]
        return h(
          Row,
          { key: view, title: label, description: desc },
          switchEl(s[key] !== false, (v: boolean) => set(key, v), label)
        )
      })
    )
  }

  // ---- Footer live-time item --------------------------------------------
  const FooterTime = (): ReturnType<typeof h> | null => {
    const s = api.settings.get()
    const { timeFormat } = useHostState()
    const enabled = s.footerTime !== false
    const withSeconds = s.footerSeconds !== false
    const [, force] = React.useState(0)
    React.useEffect(() => {
      if (!enabled) return
      // Tick every second with seconds, else align to the next minute.
      let timer = 0
      const schedule = (): void => {
        const now = Date.now()
        const delay = withSeconds ? 1000 - (now % 1000) : 60000 - (now % 60000)
        timer = window.setTimeout(() => {
          force((n) => n + 1)
          schedule()
        }, delay)
      }
      schedule()
      return () => window.clearTimeout(timer)
    }, [withSeconds, enabled])
    if (!enabled) return null
    const text = fmtWallTime(new Date(), withSeconds, timeFormat === '12h')
    return h(
      'button',
      {
        type: 'button',
        className: 'status-item status-clock',
        onClick: () => api.workspace.revealOwnPanel('right_sidebar'),
        title: uiText('auto.04f6b3ea183e'),
        style: { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"' }
      },
      text
    )
  }

  api.registerView('clock.panel', Panel)
  api.registerView('clock.footer', FooterTime)
  api.registerView('clock.settings', SettingsView)
  const offs = registerCommands(api, store)
  const offSurfaces = registerClockSurfaces(api, store)

  const onSettings = (): void => store.syncSettings()
  const offSettings = api.settings.subscribe(onSettings)
  const offNotifications = store.listen(api)

  return () => {
    offs.forEach((off) => off())
    offSurfaces()
    offSettings()
    // Without this the previous session keeps answering ring ticks after a hot
    // reload, and every alarm sounds once per surviving listener.
    offNotifications()
    disposeStyles()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
