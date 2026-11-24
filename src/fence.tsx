/**
 * ```clock``` code block — a live clock, world clocks, a timer button or a
 * countdown in a note. The first of `world`, `timer` and `countdown` that is
 * present picks the kind; otherwise the block is a clock face.
 *
 *   ```clock
 *   city: Tokyo           (city name or IANA time zone; omit for local time)
 *   seconds: false        (hide the second hand)
 *   ```
 *
 *   ```clock
 *   world:
 *     - Zurich
 *     - New York
 *   ```
 *
 *   ```clock
 *   timer: 25m            (5m, 1h30m, 90s, 0:45, or minutes as a bare number)
 *   label: Focus
 *   ```
 *
 *   ```clock
 *   countdown: 2026-12-24 18:00   (YYYY-MM-DD, optional HH:mm[:ss], local time)
 *   label: Christmas Eve
 *   ```
 */
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { fenceValue, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import codeBlockExamples from './codeBlockExamples.json'
import type { ClockStore } from './store'
import { cityName, cityTime, dayOffsetLabel, findCity, offsetLabel } from './worldClock'
import { fmtCountdown, parseDuration } from './timers'
import { fmtPresetLabel, viewEnabled } from './preferences'
import { uiText } from './localization'
import { whileVisible } from './visibility'

const MAX_TIMER_SECONDS = 999 * 3600 + 59 * 60 + 59

export type ClockFence =
  | { kind: 'time'; zone: string | null; seconds: boolean }
  | { kind: 'world'; zones: string[] }
  | { kind: 'timer'; seconds: number; label: string }
  | { kind: 'countdown'; at: number; label: string }
  | { kind: 'error'; message: string }

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** A city from Clock's list, else a valid IANA zone; null when neither. */
export function resolveZone(query: string): string | null {
  const city = findCity(query)
  if (city) return city.id ?? city.tz
  const zone = query.trim()
  return zone.includes('/') && validZone(zone) ? zone : null
}

/** Local `YYYY-MM-DD[ HH:mm[:ss]]` (a `T` separator works too) as epoch ms. */
export function parseCountdownDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw.trim())
  if (!m) return null
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number)
  const date = new Date(year, month - 1, day, hour, minute, second)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
    date.getHours() !== hour || date.getMinutes() !== minute) return null
  return date.getTime()
}

const listOf = (params: ReturnType<typeof parseFenceParams>, key: string): string[] | null => {
  const list = params.lists[key]
  if (list) return list.map(entry => entry.trim()).filter(Boolean)
  const value = params.values[key]
  return value === undefined ? null : value.split(',').map(entry => entry.trim()).filter(Boolean)
}

export function parseClockFence(code: string): ClockFence {
  const params = parseFenceParams(code)
  const label = (params.values.label ?? '').trim().slice(0, 40)
  const world = listOf(params, 'world')
  if (world) {
    const zones: string[] = []
    for (const entry of world) {
      const zone = resolveZone(entry)
      if (!zone) return { kind: 'error', message: uiText('fence.unknownCity', { name: entry }) }
      zones.push(zone)
    }
    return zones.length ? { kind: 'world', zones } : { kind: 'error', message: uiText('fence.worldEmpty') }
  }
  const timer = params.values.timer
  if (timer !== undefined) {
    const seconds = parseDuration(timer)
    if (seconds <= 0 || seconds > MAX_TIMER_SECONDS) return { kind: 'error', message: uiText('fence.badDuration', { value: timer }) }
    return { kind: 'timer', seconds, label }
  }
  const countdown = params.values.countdown
  if (countdown !== undefined) {
    const at = parseCountdownDate(countdown)
    return at === null ? { kind: 'error', message: uiText('fence.badDate', { value: countdown }) } : { kind: 'countdown', at, label }
  }
  const city = fenceValue(params, 'city', 'zone', 'tz')
  const seconds = (params.values.seconds ?? '').trim().toLowerCase() !== 'false'
  if (!city) return { kind: 'time', zone: null, seconds }
  const zone = resolveZone(city)
  return zone ? { kind: 'time', zone, seconds } : { kind: 'error', message: uiText('fence.unknownCity', { name: city }) }
}

/** A Date whose local fields read as the wall-clock time in `zone`, for the analog face. */
export function wallClockIn(zone: string, now: Date): Date {
  const [h, m, s] = cityTime(zone, now, true).split(':').map(Number)
  return new Date(2000, 0, 1, h, m, s, now.getMilliseconds())
}

const pad = (n: number): string => String(n).padStart(2, '0')

function fmtWall(date: Date, seconds: boolean, twelveHour: boolean): string {
  const tail = `${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`
  if (!twelveHour) return `${pad(date.getHours())}:${tail}`
  const hour = date.getHours() % 12 || 12
  return `${hour}:${tail} ${date.getHours() < 12 ? 'AM' : 'PM'}`
}

/** Time left as `M:SS`, `H:MM:SS`, or `D d HH:MM:SS` once it is a day or more. */
export function fmtSpan(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const days = Math.floor(total / 86_400)
  if (days === 0) return fmtCountdown(total * 1000)
  const rest = total - days * 86_400
  return `${uiText('fence.days', { count: days })} ${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}`
}

export function registerClockFence(
  api: ValleyPluginApi,
  store: ClockStore,
  renderClockFace: (showSeconds: boolean, at?: Date) => ReturnType<ValleyPluginApi['React']['createElement']>
): () => void {
  const React = api.React
  const h = React.createElement
  type Node = ReturnType<typeof h>

  const useNow = (ref: { current: HTMLElement | null }): Date => {
    const [now, setNow] = React.useState(() => new Date())
    React.useEffect(() => whileVisible(() => setNow(new Date()), 1000, ref.current), [])
    return now
  }
  const useTwelveHour = (): boolean =>
    React.useSyncExternalStore(api.subscribe, () => api.getState().timeFormat === '12h', () => false)

  const TimeBlock = ({ fence }: { fence: Extract<ClockFence, { kind: 'time' }> }): Node => {
    const ref = React.useRef<HTMLDivElement>(null)
    const now = useNow(ref)
    const twelveHour = useTwelveHour()
    const wall = fence.zone ? wallClockIn(fence.zone, now) : now
    const offset = fence.zone ? [dayOffsetLabel(fence.zone, now), offsetLabel(fence.zone, now)].filter(Boolean).join(' · ') : ''
    return h('div', { ref, className: 'clock-fence-card' },
      h('div', { className: 'clock-fence-face' }, renderClockFace(fence.seconds, wall)),
      h('div', { className: 'clock-fence-main' },
        h('div', { className: 'clock-fence-title' }, fence.zone ? cityName(fence.zone) : uiText('fence.local')),
        h('div', { className: 'clock-readout md' }, fmtWall(wall, fence.seconds, twelveHour)),
        offset ? h('div', { className: 'clock-sub' }, offset) : false))
  }

  const WorldBlock = ({ fence }: { fence: Extract<ClockFence, { kind: 'world' }> }): Node => {
    const ref = React.useRef<HTMLDivElement>(null)
    const now = useNow(ref)
    const twelveHour = useTwelveHour()
    return h('div', { ref, className: 'clock-fence-card clock-fence-world' },
      ...fence.zones.map((zone, index) => h('div', { key: `${zone}-${index}`, className: 'clock-fence-row' },
        h('div', { className: 'clock-fence-main' },
          h('div', { className: 'clock-fence-title' }, cityName(zone)),
          h('div', { className: 'clock-sub' }, [dayOffsetLabel(zone, now), offsetLabel(zone, now)].filter(Boolean).join(' · '))),
        h('div', { className: 'clock-readout sm' }, fmtWall(wallClockIn(zone, now), false, twelveHour)))))
  }

  const TimerBlock = ({ fence }: { fence: Extract<ClockFence, { kind: 'timer' }> }): Node => {
    const [started, setStarted] = React.useState(false)
    const enabled = viewEnabled('timer', api.settings.get())
    React.useEffect(() => {
      if (!started) return
      const timeout = window.setTimeout(() => setStarted(false), 2000)
      return () => window.clearTimeout(timeout)
    }, [started])
    const start = async (): Promise<void> => {
      await store.ready
      if (!store.addTimer(fence.seconds, fence.label)) return
      store.setMode('timer')
      store.notify()
      api.workspace.revealOwnPanel('right_sidebar')
      setStarted(true)
    }
    return h('div', { className: 'clock-fence-card clock-fence-timer' },
      h('div', { className: 'clock-fence-main' },
        h('div', { className: 'clock-readout md' }, fmtCountdown(fence.seconds * 1000)),
        h('div', { className: 'clock-sub' }, fence.label || fmtPresetLabel(fence.seconds))),
      enabled
        ? h('button', { className: 'clock-btn clock-btn--primary', disabled: started, onClick: () => { void start() } },
          uiText(started ? 'fence.started' : 'fence.start'))
        : h('div', { className: 'clock-sub' }, uiText('fence.timerOff')))
  }

  const CountdownBlock = ({ fence }: { fence: Extract<ClockFence, { kind: 'countdown' }> }): Node => {
    const ref = React.useRef<HTMLDivElement>(null)
    const now = useNow(ref)
    const left = fence.at - now.getTime()
    const when = new Date(fence.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    return h('div', { ref, className: 'clock-fence-card' },
      h('div', { className: 'clock-fence-main' },
        fence.label ? h('div', { className: 'clock-fence-title' }, fence.label) : false,
        h('div', { className: `clock-readout md${left <= 0 ? ' done' : ''}` }, left > 0 ? fmtSpan(left) : uiText('fence.reached')),
        h('div', { className: 'clock-sub' }, uiText(left > 0 ? 'fence.until' : 'fence.since', { date: when }))))
  }

  const ClockFenceView = ({ code }: { code: string }): Node => {
    const fence = React.useMemo(() => parseClockFence(code), [code])
    switch (fence.kind) {
      case 'time': return h(TimeBlock, { fence })
      case 'world': return h(WorldBlock, { fence })
      case 'timer': return h(TimerBlock, { fence })
      case 'countdown': return h(CountdownBlock, { fence })
      default: return h('div', { className: 'clock-fence-error' }, fence.message)
    }
  }

  return api.markdown.registerCodeBlockRenderer('clock', (code, el) => {
    el.classList.add('clock-fence')
    return api.ui.renderReact(el, h(ClockFenceView, { code }))
  }, { examples: codeBlockExamples.clock })
}
