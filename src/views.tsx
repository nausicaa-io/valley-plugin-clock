import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import type { ClockStore } from './store'
import { SOUND_IDS, SOUND_LABEL, type AlarmSoundId, type SoundPlayback } from './sounds'
import { CITIES, cityId, cityName, cityMatches, cityTime, isDaytime, dayOffsetLabel, offsetLabel } from './worldClock'
import { orderedWeekdays, repeatLabel, type ClockAlarm } from './alarms'
import { fmtStopwatch } from './stopwatch'
import { fmtCountdown, parseDuration, type ClockTimer } from './timers'
import { timerPresets, fmtPresetLabel, orderedModes, visibleModes, viewEnabled, type Mode } from './preferences'
import { reorder, setIconDragImage, dropDestination, type DragLike } from './reorder'
import { createClockSettings } from './settings'

// ---- Palette ---------------------------------------------------------------
// Face + ink follow the theme: the disc inverts against the panel (white on a
// light theme — classic SBB — dark on a dark theme) while the marks/hands take
// the strongest foreground token so they stay crisp in both.
const FACE = 'var(--container-color-alt)'
const INK = 'var(--title-color)'
const DIAL_EDGE = 'var(--border-medium)'
const ACCENT = 'var(--accent-color)'

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

export function createClockViews(api: ValleyPluginApi, store: ClockStore) {
  const React = api.React
  const h = React.createElement
  const { SelectField } = api.ui.settings
  const pad = (n: number): string => String(n).padStart(2, '0')

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
        const next = store.playSound(sound, () => {
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

  const endDrag = (): void => {
    if (store.state.worldDrag != null || store.state.worldDrop != null) {
      store.state.worldDrag = null
      store.state.worldDrop = null
      store.notify()
    }
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

  const SettingsView = createClockSettings(api, store, { worldAddSelect, worldList, pomodoroIcon: tabIcon.pomodoro })
  return { Panel, SettingsView }
}
