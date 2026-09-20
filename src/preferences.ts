import { parseDuration } from './timers'

export type Mode = 'clock' | 'alarm' | 'stopwatch' | 'timer' | 'pomodoro'

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

