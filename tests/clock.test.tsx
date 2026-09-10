import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import {
  register,
  cityTime,
  cityHour,
  isDaytime,
  reorder,
  dayOffsetLabel,
  pomodoroNextPhase,
  parseDuration,
  parseClockTime,
  parseDays,
  orderedWeekdays,
  nextAlarmAt,
  nextOccurrences,
  repeatLabel,
  fmtCountdown,
  fmtStopwatch,
  fmtPresetLabel,
  timerPresets,
  TIMER_PRESET_LIMIT,
  DEFAULT_TIMER_PRESETS,
  orderedModes,
  visibleModes,
  viewEnabled,
  CITIES
} from '../src/index'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { ClockAlarm, ClockStore } from '../src/index'

interface ClockTimerLike {
  id: string
  label: string
  running: boolean
}
interface ClockStoreLike {
  state: { worldCities: string[]; timers: ClockTimerLike[] }
  worldAdd(q: string): unknown
  worldMove(from: number, to: number): boolean
  addTimer(seconds: number, label?: string): unknown
  syncSettings(): void
  swStart(): void
  swStop(): void
  swElapsed(): number
}
const getStore = (api: ReturnType<typeof createMockValleyApi>['api']): ClockStoreLike =>
  api.runtime.getOrCreate<ClockStoreLike>('clock.store', () => {
    throw new Error('Clock did not initialize its runtime store')
  })

/** Register the plugin against a fresh mock api and return the panel + settings views. */
function mountRegister(settings: Record<string, unknown> = {}): {
  api: ReturnType<typeof createMockValleyApi>['api']
  mock: ReturnType<typeof createMockValleyApi>
  view: (key: string) => React.ComponentType<{ section?: string }> | undefined
} {
  const mock = createMockValleyApi({ manifest: { id: 'clock' }, settings })
  const { api } = mock
  register(api)
  const calls = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType<{ section?: string }>][] } }).mock.calls
  return { api, mock, view: (key) => calls.find(([id]) => id === key)?.[1] }
}

/** rAF is stubbed out so the panel's animation loop never schedules in jsdom. */
function withStubbedRaf<T>(fn: () => T): T {
  const raf = window.requestAnimationFrame
  const caf = window.cancelAnimationFrame
  window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame
  try {
    return fn()
  } finally {
    window.requestAnimationFrame = raf
    window.cancelAnimationFrame = caf
  }
}

afterEach(() => {
  cleanup()
})

describe('clock pure helpers', () => {
  it('formats a city time in its own zone (24h)', () => {
    // 2024-01-01T00:00:00Z → Tokyo is UTC+9 → 09:00.
    const d = new Date('2024-01-01T00:00:00Z')
    expect(cityTime('Asia/Tokyo', d)).toBe('09:00')
    expect(cityTime('Asia/Tokyo', d, true)).toBe('09:00:00')
  })

  it('labels the day offset relative to the local day', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    // A zone equal to the local zone is always "Today".
    expect(dayOffsetLabel(local, new Date('2024-06-01T12:00:00Z'))).toBe('Today')
    // Every zone yields one of the Apple-style labels.
    const valid = /^(Today|Tomorrow|Yesterday|[+-]\d+ days)$/
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
      expect(dayOffsetLabel(tz, new Date('2024-01-01T23:00:00Z'))).toMatch(valid)
    }
  })

  it('advances Pomodoro phases with a long break every N work sessions', () => {
    expect(pomodoroNextPhase('work', 0, 4)).toEqual({ phase: 'short', cycle: 1 })
    expect(pomodoroNextPhase('short', 1, 4)).toEqual({ phase: 'work', cycle: 1 })
    expect(pomodoroNextPhase('work', 3, 4)).toEqual({ phase: 'long', cycle: 0 })
    expect(pomodoroNextPhase('long', 0, 4)).toEqual({ phase: 'work', cycle: 0 })
  })

  it('parses durations (bare number = minutes)', () => {
    expect(parseDuration('5m')).toBe(300)
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('90s')).toBe(90)
    expect(parseDuration('25')).toBe(1500)
    expect(parseDuration('nope')).toBe(0)
  })

  it('formats a countdown', () => {
    expect(fmtCountdown(5000)).toBe('00:05')
    expect(fmtCountdown(3_600_000)).toBe('1:00:00')
  })

  it('ships a curated, zone-valid city list', () => {
    expect(CITIES.length).toBeGreaterThan(60)
    expect(CITIES.map((city) => city.name)).toEqual(expect.arrayContaining(['Bern', 'Zürich', 'Geneva', 'San Francisco']))
    for (const c of CITIES) expect(() => cityTime(c.tz, new Date())).not.toThrow()
  })

  it('reports a zone-local hour and an Apple-style day/night flag', () => {
    // Tokyo is UTC+9 with no DST: 03:00Z → 12:00 (day), 15:00Z → 00:00 (night).
    const noon = new Date('2024-01-01T03:00:00Z')
    const midnight = new Date('2024-01-01T15:00:00Z')
    expect(cityHour('Asia/Tokyo', noon)).toBe(12)
    expect(cityHour('Asia/Tokyo', midnight)).toBe(0)
    expect(isDaytime('Asia/Tokyo', noon)).toBe(true)
    expect(isDaytime('Asia/Tokyo', midnight)).toBe(false)
    // Invalid zones never throw and default to daytime.
    expect(isDaytime('Not/AZone', noon)).toBe(true)
  })

  it('reorders a list immutably without mutating the source', () => {
    const src = ['a', 'b', 'c', 'd']
    expect(reorder(src, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder(src, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(src).toEqual(['a', 'b', 'c', 'd']) // untouched
    // Out-of-range / no-op indices return an unchanged copy.
    expect(reorder(src, 1, 1)).toEqual(src)
    expect(reorder(src, 9, 0)).toEqual(src)
  })

  it('parses wall-clock times and rejects out-of-range input', () => {
    expect(parseClockTime('07:30')).toEqual({ hour: 7, minute: 30 })
    expect(parseClockTime('7.05')).toEqual({ hour: 7, minute: 5 })
    expect(parseClockTime('0730')).toEqual({ hour: 7, minute: 30 })
    expect(parseClockTime('7')).toEqual({ hour: 7, minute: 0 })
    expect(parseClockTime('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseClockTime('24:00')).toBeNull()
    expect(parseClockTime('12:60')).toBeNull()
    expect(parseClockTime('nope')).toBeNull()
    expect(parseClockTime('')).toBeNull()
  })

  it('parses CLI repeat specs into weekday indices', () => {
    expect(parseDays('mon,wed,fri')).toEqual([1, 3, 5])
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('weekends')).toEqual([0, 6])
    expect(parseDays('daily')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseDays('sun sat')).toEqual([0, 6])
    // Unknown tokens are ignored; nothing parseable ⇒ a one-shot.
    expect(parseDays('mon,zzz')).toEqual([1])
    expect(parseDays('')).toEqual([])
  })

  it('rotates the weekday order to the user week-start preference', () => {
    expect(orderedWeekdays('monday')).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(orderedWeekdays('sunday')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(orderedWeekdays('saturday')).toEqual([6, 0, 1, 2, 3, 4, 5])
    // An unknown preference falls back to Monday.
    expect(orderedWeekdays('someday')).toEqual([1, 2, 3, 4, 5, 6, 0])
  })

  describe('nextAlarmAt', () => {
    const alarm = (over: Partial<ClockAlarm> = {}): ClockAlarm => ({
      id: 'a1',
      hour: 7,
      minute: 30,
      label: '',
      days: [],
      sound: 'beep',
      enabled: true,
      ...over
    })
    // A Wednesday, 12:00 local.
    const wed = new Date(2026, 6, 22, 12, 0, 0, 0)

    it('returns null for a disabled alarm', () => {
      expect(nextAlarmAt(alarm({ enabled: false }), wed)).toBeNull()
    })

    it('rolls a bare one-shot to tomorrow once its time has passed', () => {
      // 07:30 already passed at 12:00 → tomorrow.
      expect(nextAlarmAt(alarm(), wed)).toBe(new Date(2026, 6, 23, 7, 30).getTime())
      // 18:00 is still ahead → today.
      expect(nextAlarmAt(alarm({ hour: 18, minute: 0 }), wed)).toBe(new Date(2026, 6, 22, 18, 0).getTime())
    })

    it('honours an explicit one-shot date and expires after it', () => {
      expect(nextAlarmAt(alarm({ date: '2026-07-25' }), wed)).toBe(new Date(2026, 6, 25, 7, 30).getTime())
      expect(nextAlarmAt(alarm({ date: '2026-07-20' }), wed)).toBeNull()
      expect(nextAlarmAt(alarm({ date: 'garbage' }), wed)).toBeNull()
    })

    it('finds the next matching weekday, crossing the week boundary', () => {
      // Wednesday 12:00, repeating Wed → next Wednesday (today already passed).
      expect(nextAlarmAt(alarm({ days: [3] }), wed)).toBe(new Date(2026, 6, 29, 7, 30).getTime())
      // Repeating Wed at 18:30 → still today.
      expect(nextAlarmAt(alarm({ days: [3], hour: 18 }), wed)).toBe(new Date(2026, 6, 22, 18, 30).getTime())
      // Repeating Sunday from a Wednesday → the coming Sunday.
      expect(nextAlarmAt(alarm({ days: [0] }), wed)).toBe(new Date(2026, 6, 26, 7, 30).getTime())
      // Every day → tomorrow, since 07:30 has passed.
      expect(nextAlarmAt(alarm({ days: [0, 1, 2, 3, 4, 5, 6] }), wed)).toBe(new Date(2026, 6, 23, 7, 30).getTime())
    })

    it('lands on the real local wall-clock time across a DST change', () => {
      // Europe/Berlin springs forward on 2026-03-29. Asking on the 28th for a
      // daily 07:30 must give the 29th at 07:30 local — not 08:30 — which a
      // naive +24h stride would produce.
      const beforeDst = new Date(2026, 2, 28, 12, 0, 0, 0)
      const at = nextAlarmAt(alarm({ days: [0, 1, 2, 3, 4, 5, 6] }), beforeDst)
      const landed = new Date(at!)
      expect(landed.getHours()).toBe(7)
      expect(landed.getMinutes()).toBe(30)
      expect(landed.getDate()).toBe(29)
    })
  })

  describe('nextOccurrences', () => {
    const alarm = (over: Partial<ClockAlarm> = {}): ClockAlarm => ({
      id: 'a1',
      hour: 7,
      minute: 30,
      label: '',
      days: [],
      sound: 'beep',
      enabled: true,
      ...over
    })
    const wed = new Date(2026, 6, 22, 12, 0, 0, 0)

    it('hands the host a run of concrete instants for a recurring alarm', () => {
      // The host schedules instants, not recurrence — weekday and DST logic
      // stays here, so it must be able to hand over several at a time or a
      // closed window would run the list dry.
      const times = nextOccurrences(alarm({ days: [1, 3] }), 4, wed)
      expect(times).toHaveLength(4)
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(new Set(times).size).toBe(4)
      for (const at of times) {
        const landed = new Date(at)
        expect([1, 3]).toContain(landed.getDay())
        expect(landed.getHours()).toBe(7)
        expect(landed.getMinutes()).toBe(30)
      }
    })

    it('gives a one-shot exactly one instant, never rolling it forward', () => {
      // Asking for more must not turn "once" into a daily alarm.
      expect(nextOccurrences(alarm(), 8, wed)).toEqual([new Date(2026, 6, 23, 7, 30).getTime()])
    })

    it('returns nothing for an alarm that can never fire again', () => {
      expect(nextOccurrences(alarm({ enabled: false }), 8, wed)).toEqual([])
      expect(nextOccurrences(alarm({ date: '2026-07-20' }), 8, wed)).toEqual([])
    })

    it('keeps every instant on the real local wall clock across DST', () => {
      const beforeDst = new Date(2026, 2, 28, 12, 0, 0, 0)
      for (const at of nextOccurrences(alarm({ days: [0, 1, 2, 3, 4, 5, 6] }), 4, beforeDst)) {
        const landed = new Date(at)
        expect(landed.getHours()).toBe(7)
        expect(landed.getMinutes()).toBe(30)
      }
    })
  })

  describe('repeatLabel', () => {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const alarm = (days: number[], date?: string): ClockAlarm => ({
      id: 'a1',
      hour: 7,
      minute: 0,
      label: '',
      days,
      date,
      sound: 'beep',
      enabled: true
    })

    it('names the common recurrence patterns', () => {
      expect(repeatLabel(alarm([0, 1, 2, 3, 4, 5, 6]), 'monday', names)).toBe('Every day')
      expect(repeatLabel(alarm([1, 2, 3, 4, 5]), 'monday', names)).toBe('Weekdays')
      expect(repeatLabel(alarm([0, 6]), 'monday', names)).toBe('Weekends')
    })

    it('lists irregular days starting at the user week start', () => {
      expect(repeatLabel(alarm([0, 1, 5]), 'monday', names)).toBe('Mon Fri Sun')
      expect(repeatLabel(alarm([0, 1, 5]), 'sunday', names)).toBe('Sun Mon Fri')
    })

    it('falls back to the date, then to "Once", for a one-shot', () => {
      expect(repeatLabel(alarm([], '2026-07-25'), 'monday', names)).toBe('2026-07-25')
      expect(repeatLabel(alarm([]), 'monday', names)).toBe('Once')
    })
  })
})

describe('clock plugin', () => {
  it('registers right-sidebar panel, footer and settings views via register(api)', () => {
    const { api } = createMockValleyApi({ manifest: { id: 'clock' } })
    register(api)
    const keys = (api.registerView as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (c) => c[0]
    )
    expect(keys).toContain('clock.panel')
    expect(keys).toContain('clock.footer')
    expect(keys).toContain('clock.settings')
  })

  it('renders the SBB face: accent second hand + disc, square-ended ink bars, ink hub', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister({ seconds: true })
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      const accent = 'var(--accent-color)'
      // Themable ink — follows --title-color, which is defined in every theme.
      const ink = 'var(--title-color)'
      // Accent second hand with flat (square) ends — no rounded caps / border radius.
      const sec = container.querySelector(`line[stroke="${accent}"]`)
      expect(sec).not.toBeNull()
      expect(sec?.getAttribute('stroke-linecap')).toBe('butt')
      // The iconic accent disc near the tip.
      expect(container.querySelector(`circle[fill="${accent}"]`)).not.toBeNull()
      // Hour + minute hands: ink bars, also square-ended.
      const hour = container.querySelector('line[stroke-width="5.4"]')
      const minute = container.querySelector('line[stroke-width="4.4"]')
      expect(hour?.getAttribute('stroke')).toBe(ink)
      expect(hour?.getAttribute('stroke-linecap')).toBe('butt')
      expect(minute?.getAttribute('stroke')).toBe(ink)
      expect(minute?.getAttribute('stroke-linecap')).toBe('butt')
      // Small ink center hub at the dial center.
      const hub = [...container.querySelectorAll('circle')].find(
        (c) => c.getAttribute('cx') === '50' && c.getAttribute('cy') === '50' && c.getAttribute('r') === '3.2'
      )
      expect(hub?.getAttribute('fill')).toBe(ink)
    })
  })

  it('renders a digital clock face (no analog dial) when clockDisplay is digital', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister({ clockDisplay: 'digital', seconds: true })
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      // Digital readout: a tabular time string, and crucially no analog clock dial.
      expect(container.querySelector('svg[viewBox="0 0 100 100"]')).toBeNull()
      expect(container.textContent).toMatch(/\d{2}:\d{2}/)
    })
  })

  it('reorders world cities through the store (drives drag-to-reorder + CLI)', () => {
    const { api } = mountRegister()
    const store = getStore(api)
    store.worldAdd('Tokyo')
    store.worldAdd('London')
    expect(store.state.worldCities).toEqual(['Asia/Tokyo', 'Europe/London'])
    expect(store.worldMove(0, 1)).toBe(true)
    expect(store.state.worldCities).toEqual(['Europe/London', 'Asia/Tokyo'])
    // A no-op move reports false.
    expect(store.worldMove(0, 0)).toBe(false)
  })

  it('keeps Bern and Zürich as separate Apple-style city entries in the same time zone', () => {
    const { api } = mountRegister()
    const store = getStore(api)
    store.worldAdd('Bern')
    store.worldAdd('Zuerich')
    expect(store.state.worldCities).toEqual(['Europe/Zurich#Bern', 'Europe/Zurich'])
    expect(cityTime(store.state.worldCities[0], new Date('2026-01-01T12:00:00Z'))).toBe(
      cityTime(store.state.worldCities[1], new Date('2026-01-01T12:00:00Z'))
    )
  })

  it('includes the requested world-clock city catalog and keeps shared-zone cities distinct', () => {
    const requested = [
      'Shanghai', 'Shenzhen', 'Beijing', 'Guangzhou', 'Chengdu', 'Hangzhou', 'Wuhan', 'Chongqing', 'Hong Kong', 'Macao',
      'Tokyo', 'Osaka', 'Kyoto', 'Nagoya', 'Seoul', 'Busan', 'Taipei', 'Kaohsiung',
      'New York', 'Los Angeles', 'Chicago', 'San Francisco', 'Miami', 'Dallas', 'Seattle', 'Honolulu',
      'Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Mexico City', 'Guadalajara',
      'London', 'Paris', 'Berlin', 'Zurich', 'Amsterdam', 'Brussels', 'Vienna', 'Geneva',
      'Rome', 'Madrid', 'Lisbon', 'Athens', 'Stockholm', 'Oslo', 'Copenhagen', 'Dublin',
      'Moscow', 'Warsaw', 'Prague', 'Budapest', 'Bucharest', 'Kyiv',
      'Mumbai', 'New Delhi', 'Bengaluru', 'Dhaka', 'Karachi', 'Colombo',
      'Singapore', 'Bangkok', 'Jakarta', 'Kuala Lumpur', 'Manila', 'Ho Chi Minh City',
      'Dubai', 'Abu Dhabi', 'Riyadh', 'Doha', 'Tel Aviv', 'Istanbul', 'Muscat',
      'Tashkent', 'Almaty', 'Baku', 'Tbilisi',
      'São Paulo', 'Rio de Janeiro', 'Buenos Aires', 'Santiago', 'Lima', 'Bogotá',
      'Panama City', 'San José', 'San Juan', 'Havana',
      'Cairo', 'Casablanca', 'Lagos', 'Accra', 'Nairobi', 'Johannesburg', 'Cape Town', 'Addis Ababa',
      'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Auckland', 'Wellington'
    ]
    const available = new Set(CITIES.flatMap((city) => [city.name, ...(city.aliases ?? [])]))
    expect(requested.filter((name) => !available.has(name))).toEqual([])
    const chinaIds = CITIES.filter((city) => ['Shanghai', 'Shenzhen', 'Beijing', 'Guangzhou'].includes(city.name))
      .map((city) => city.id ?? city.tz)
    expect(new Set(chinaIds).size).toBe(chinaIds.length)
  })

  it('treats an unwritten view setting as enabled and only `false` as off', () => {
    expect(visibleModes({})).toEqual(['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro'])
    expect(visibleModes({ showAlarm: false, showTimer: false })).toEqual(['clock', 'stopwatch', 'pomodoro'])
    expect(viewEnabled('world', {})).toBe(true)
    expect(viewEnabled('world', { showWorld: false })).toBe(false)
  })

  it('drops a switched-off view from the tab strip, and the world list from the Clock tab', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister({ showAlarm: false, showPomodoro: false, showWorld: false })
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      expect(screen.queryByRole('tab', { name: 'Alarm' })).toBeNull()
      expect(screen.queryByRole('tab', { name: 'Pomodoro' })).toBeNull()
      expect(screen.getByRole('tab', { name: 'Stopwatch' })).toBeTruthy()
      // World clock lives inside the Clock tab, so its heading goes, not a tab.
      expect(screen.getByRole('tab', { name: 'Clock' })).toBeTruthy()
      expect(screen.queryByText('World clock')).toBeNull()
    })
  })

  it('falls back to the Clock tab when the open tab is switched off', () => {
    withStubbedRaf(() => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Timer' }))
      expect(screen.getByRole('tab', { name: 'Timer' }).getAttribute('aria-selected')).toBe('true')
      // Turning the view off must not strand the panel on a tab with no button.
      ;(api.settings.get() as Record<string, unknown>).showTimer = false
      act(() => getStore(api).syncSettings())
      expect(screen.queryByRole('tab', { name: 'Timer' })).toBeNull()
      expect(screen.getByRole('tab', { name: 'Clock' }).getAttribute('aria-selected')).toBe('true')
    })
  })

  it('hides the tab strip entirely once only the Clock view is left', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister({
        showAlarm: false,
        showStopwatch: false,
        showTimer: false,
        showPomodoro: false
      })
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      expect(screen.queryByRole('tablist')).toBeNull()
    })
  })

  it('filters the city search as you type and adds the clicked match', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      const field = screen.getByLabelText('Search cities…')
      // Focus alone opens the full list — browsing still works without typing.
      fireEvent.focus(field)
      expect(screen.getByLabelText('Add Tokyo')).toBeTruthy()
      expect(screen.getByLabelText('Add London')).toBeTruthy()
      fireEvent.change(field, { target: { value: 'tok' } })
      expect(screen.queryByLabelText('Add London')).toBeNull()
      // Adding persists the list, whose settings write notifies asynchronously.
      await act(async () => void fireEvent.click(screen.getByLabelText('Add Tokyo')))
      expect(getStore(api).state.worldCities).toEqual(['Asia/Tokyo'])
      // The query clears, and an added city drops out of the remaining matches.
      expect((field as HTMLInputElement).value).toBe('')
      fireEvent.focus(field)
      expect(screen.queryByLabelText('Add Tokyo')).toBeNull()
      fireEvent.change(field, { target: { value: 'zue' } })
      expect(screen.getByLabelText('Add Zürich')).toBeTruthy()
    })
  })

  it('takes the top match on Enter and reports a query nothing matches', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      const field = screen.getByLabelText('Search cities…')
      fireEvent.change(field, { target: { value: 'tok' } })
      await act(async () => void fireEvent.keyDown(field, { key: 'Enter' }))
      expect(getStore(api).state.worldCities).toEqual(['Asia/Tokyo'])
      fireEvent.change(field, { target: { value: 'atlantis' } })
      expect(screen.getByText('No city matches that.')).toBeTruthy()
      // Enter on nothing must not add a city.
      await act(async () => void fireEvent.keyDown(field, { key: 'Enter' }))
      expect(getStore(api).state.worldCities).toEqual(['Asia/Tokyo'])
    })
  })

  it('arranges the tab strip in the saved order, ignoring hidden and unknown ids', () => {
    const visible = visibleModes({})
    expect(orderedModes(visible, ['timer', 'clock'])).toEqual(['timer', 'clock', 'alarm', 'stopwatch', 'pomodoro'])
    // A saved id for a switched-off view must not bring its tab back.
    expect(orderedModes(visibleModes({ showTimer: false }), ['timer', 'pomodoro'])).toEqual([
      'pomodoro',
      'clock',
      'alarm',
      'stopwatch'
    ])
    // Junk and duplicates in the stored value cannot corrupt the strip.
    expect(orderedModes(visible, ['alarm', 'alarm', 'nope'])).toEqual([
      'alarm',
      'clock',
      'stopwatch',
      'timer',
      'pomodoro'
    ])
    expect(orderedModes(visible, [])).toEqual(visible)
  })

  it('reorders the tab strip by drag and persists the new order', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      const tabs = (): string[] =>
        screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label') ?? '')
      expect(tabs()).toEqual(['Clock', 'Alarm', 'Stopwatch', 'Timer', 'Pomodoro'])
      const timer = screen.getByRole('tab', { name: 'Timer' })
      const clock = screen.getByRole('tab', { name: 'Clock' })
      let dragImage: Element | null = null
      const dataTransfer = {
        setDragImage: vi.fn((image: Element) => { dragImage = image }),
        effectAllowed: '',
        dropEffect: ''
      }
      const alarm = screen.getByRole('tab', { name: 'Alarm' })
      fireEvent.dragStart(alarm, { dataTransfer })
      expect((dragImage as Element | null)?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
      fireEvent.dragEnd(alarm)
      await act(async () => {
        fireEvent.dragStart(timer, { dataTransfer })
        expect((dragImage as Element | null)?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 512 512')
        fireEvent.drop(clock)
      })
      expect(tabs()).toEqual(['Timer', 'Clock', 'Alarm', 'Stopwatch', 'Pomodoro'])
      expect(JSON.parse(String((api.settings.get() as Record<string, unknown>).tabOrder))).toEqual([
        'timer',
        'clock',
        'alarm',
        'stopwatch',
        'pomodoro'
      ])
    })
  })

  it('measures the stopwatch from wall-clock timestamps, not a tick count', () => {
    const { api } = mountRegister()
    const store = getStore(api)
    const now = vi.spyOn(Date, 'now')
    try {
      // Not one render, tick or frame happens between start and read — the
      // elapsed time is derived from the two timestamps alone.
      now.mockReturnValue(1_000_000)
      store.swStart()
      now.mockReturnValue(1_060_000)
      expect(fmtStopwatch(store.swElapsed())).toBe('01:00.00')
      // Paused time is banked, and the wall clock moving on cannot add to it.
      store.swStop()
      now.mockReturnValue(9_000_000)
      expect(fmtStopwatch(store.swElapsed())).toBe('01:00.00')
      // Resuming measures from the new start and adds to what was banked.
      store.swStart()
      now.mockReturnValue(9_030_000)
      expect(fmtStopwatch(store.swElapsed())).toBe('01:30.00')
    } finally {
      now.mockRestore()
    }
  })

  it('renders timers digitally, with a progress bar and no dial', () => {
    withStubbedRaf(() => {
      // A stale analog preference from an older install must not bring the dial
      // back: only the clock and the stopwatch have a face to choose.
      const { view } = mountRegister({ timerDisplay: 'analog' })
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Timer' }))
      fireEvent.click(screen.getByText('5m'))
      expect(container.querySelector('svg[viewBox="0 0 100 100"]')).toBeNull()
      expect(container.querySelector('.clock-progress-fill')).not.toBeNull()
      expect(container.textContent).toMatch(/05:00/)
    })
  })

  it('draws world rows in the app icon idiom, not as pasted text glyphs', async () => {
    await withStubbedRaf(async () => {
      const { mock, view } = mountRegister()
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      const field = screen.getByLabelText('Search cities…')
      fireEvent.change(field, { target: { value: 'tokyo' } })
      await act(async () => void fireEvent.keyDown(field, { key: 'Enter' }))
      const row = container.querySelector('.clock-line-row')!
      expect(row.textContent).not.toMatch(/[☀☾⠿×]/)
      expect(row.querySelector('.clock-line-glyph svg')).not.toBeNull()
      expect(row.querySelector('.clock-icon-btn')).toBeNull()
      expect(row.querySelector('.clock-line-time')?.textContent).toMatch(/^\d{1,2}:\d{2}$/)
      expect(row.querySelector('.clock-sub')?.textContent).toBeTruthy()
      // The panel list reorders by drag too, not just Settings → World.
      expect(row.getAttribute('draggable')).toBe('true')
      expect(row.querySelector('.clock-grip')).toBeNull()
      let dragImage: Element | null = null
      fireEvent.dragStart(row, { dataTransfer: { setDragImage: (image: Element) => { dragImage = image } } })
      expect((dragImage as Element | null)?.querySelector('svg')?.innerHTML).toBe(row.querySelector('.clock-line-glyph svg')?.innerHTML)
      fireEvent.click(screen.getByLabelText('World clock settings'))
      expect(mock.api.workspace.openOwnSettings).toHaveBeenCalledWith('world')
    })
  })

  it('keeps city removal in World clock settings instead of the right sidebar', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      getStore(api).worldAdd('Tokyo')
      const Settings = view('clock.settings')!
      const { container } = render(React.createElement(Settings, { section: 'world' }))
      expect(container.querySelector('.clock-world-settings')).not.toBeNull()
      expect(container.querySelector('.clock-line-row .clock-grip svg')).not.toBeNull()
      expect(container.querySelector('.clock-line-row .clock-icon-btn svg')).not.toBeNull()
      await act(async () => void fireEvent.click(screen.getByLabelText('Remove Tokyo')))
      expect(getStore(api).state.worldCities).toEqual([])
    })
  })

  it('creates a Pomodoro from the chooser and opens its detail settings with spaces intact', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      const panel = render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Pomodoro' }))
      fireEvent.click(screen.getByRole('button', { name: 'Choose Pomodoro' }))
      await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add Pomodoro' })))
      expect(api.workspace.openOwnSettings).toHaveBeenCalledWith('pomodoro')
      const store = api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
      await store.flush()
      expect(store.pomoProfiles()).toHaveLength(2)
      const created = store.pomoProfiles()[1]
      panel.unmount()
      const Settings = view('clock.settings')!
      render(React.createElement(Settings, { section: 'pomodoro' }))
      const name = screen.getByLabelText('Name') as HTMLInputElement
      expect(name.value).toBe(created.name)
      await act(async () => void fireEvent.change(name, { target: { value: 'Deep ' } }))
      await store.flush()
      expect(store.pomoProfiles()[1].name).toBe('Deep ')
      await act(async () => {
        fireEvent.change(name, { target: { value: 'Deep Work' } })
        fireEvent.blur(name)
      })
      await store.flush()
      expect(store.pomoProfiles()[1].name).toBe('Deep Work')
    })
  })

  it('offers no date picker in the alarm editor', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister()
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Alarm' }))
      act(() => void fireEvent.click(screen.getByText('New alarm')))
      // A one-shot means "the next time the clock reads that time" — there is
      // nothing to pick a date for, and the editor must not ask.
      expect(screen.getByLabelText('Alarm name')).toBeTruthy()
      // Unquoted attribute selector on purpose: `pluginImportBoundary` sweeps
      // every plugin .tsx for a quoted type="date" literal, and cannot tell an
      // assertion that there is none from an actual native date input.
      expect(container.querySelector('input[type=date]')).toBeNull()
      expect(screen.queryByText('Date')).toBeNull()
    })
  })

  it('reorders Pomodoro profiles by dragging their Settings rows', async () => {
    const { api, view } = mountRegister()
    const store = api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
    let second!: ReturnType<ClockStore['addPomoProfile']>
    let third!: ReturnType<ClockStore['addPomoProfile']>
    await act(async () => {
      second = store.addPomoProfile('Second')
      third = store.addPomoProfile('Third')
      await store.flush()
      await Promise.resolve()
    })
    const Settings = view('clock.settings')!
    const { container } = render(React.createElement(Settings, { section: 'pomodoro' }))
    let rows = container.querySelectorAll<HTMLElement>('.settings-list-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].getAttribute('draggable')).toBe('true')
    let dragImage: Element | null = null
    fireEvent.dragStart(rows[2], { dataTransfer: { setDragImage: (image: Element) => { dragImage = image } } })
    rows = container.querySelectorAll<HTMLElement>('.settings-list-row')
    fireEvent.dragOver(rows[0], { dataTransfer: {} })
    expect(container.querySelectorAll<HTMLElement>('.settings-list-row')[0].dataset.dropPosition).toBe('before')
    await act(async () => {
      fireEvent.drop(container.querySelectorAll<HTMLElement>('.settings-list-row')[0], { dataTransfer: {} })
      await store.flush()
    })
    expect(store.pomoProfiles().map((profile) => profile.id)).toEqual([third.id, 'focus', second.id])
    expect((dragImage as Element | null)?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 15 15')
  })

  it('reads the quick-timer chips from settings, canonicalised and capped', () => {
    expect(timerPresets({})).toEqual(DEFAULT_TIMER_PRESETS)
    // Every accepted duration spelling collapses to one label, so the chip and
    // the panel button can never disagree about what the same preset is called.
    expect(timerPresets({ timerPresets: JSON.stringify(['90s', '2', '1h30m']) })).toEqual(['1m30s', '2m', '1h30m'])
    expect(fmtPresetLabel(3600)).toBe('1h')
    // Junk, a duplicate under another spelling, and anything past the limit go.
    expect(timerPresets({ timerPresets: ['5m', 'nope', '300s', '1m', '2m', '3m', '4m', '6m'] })).toEqual([
      '5m',
      '1m',
      '2m',
      '3m',
      '4m'
    ])
    // An emptied list is the user's answer, not a missing one: it must not fall
    // back to the defaults the way an unset value does.
    expect(timerPresets({ timerPresets: '[]' })).toEqual([])
  })

  it('drops the panel chip row when the user has cleared every quick timer', () => {
    withStubbedRaf(() => {
      const { view } = mountRegister({ timerPresets: '[]' })
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Timer' }))
      expect(container.querySelector('.clock-preset-row')).toBeNull()
      // The hand-dialled adder is what remains — the tab is still usable.
      expect(screen.getByText('Add timer')).toBeTruthy()
    })
  })

  it('settings edits the quick timers instead of running a second Timer', async () => {
    const { mock, view } = mountRegister()
    const Settings = view('clock.settings')!
    render(React.createElement(Settings, { section: 'timer' }))
    // The adder and the live list belong to the panel; Settings must not fork them.
    expect(screen.queryByText('Add a timer')).toBeNull()
    expect(screen.queryByText('Running timers')).toBeNull()
    const field = screen.getByLabelText('Quick timers')
    for (const label of DEFAULT_TIMER_PRESETS) expect(screen.getByText(label)).toBeTruthy()
    // A sixth chip is refused at the write too, not only in the field's own
    // validation — the stored list can never outgrow the row it draws.
    await act(async () => {
      fireEvent.change(field, { target: { value: '45m' } })
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    const write = mock.driverCalls.find((c) => c.method === 'updatePluginSettings')?.payload as
      | { key: string; value: string }
      | undefined
    expect(write?.key).toBe('timerPresets')
    expect(JSON.parse(write!.value)).toHaveLength(TIMER_PRESET_LIMIT)
  })

  it('adds a named plant-care timer from the panel adder', () => {
    withStubbedRaf(() => {
      const { api, view } = mountRegister()
      const Panel = view('clock.panel')!
      render(React.createElement(Panel))
      fireEvent.click(screen.getByRole('tab', { name: 'Timer' }))
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Water fern' } })
      fireEvent.click(screen.getByText('5m'))
      const timers = getStore(api).state.timers
      expect(timers).toHaveLength(1)
      expect(timers[0].label).toBe('Water fern')
    })
  })

  it('reorders Timer and Alarm cards by dragging the cards with their own icons', async () => {
    await withStubbedRaf(async () => {
      const { api, view } = mountRegister()
      const store = api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
      let firstTimer!: NonNullable<ReturnType<ClockStore['addTimer']>>
      let secondTimer!: NonNullable<ReturnType<ClockStore['addTimer']>>
      let firstAlarm!: ReturnType<ClockStore['addAlarm']>
      let secondAlarm!: ReturnType<ClockStore['addAlarm']>
      await act(async () => {
        firstTimer = store.addTimer(60, 'First')!
        secondTimer = store.addTimer(120, 'Second')!
        firstAlarm = store.addAlarm({ hour: 8, minute: 0, label: 'First' })
        secondAlarm = store.addAlarm({ hour: 9, minute: 0, label: 'Second' })
        await store.flush()
      })
      const Panel = view('clock.panel')!
      const { container } = render(React.createElement(Panel))

      fireEvent.click(screen.getByRole('tab', { name: 'Timer' }))
      let timerCards = container.querySelectorAll<HTMLElement>('.clock-card')
      expect(timerCards).toHaveLength(2)
      expect(timerCards[0].getAttribute('draggable')).toBe('true')
      expect(timerCards[0].querySelector('.clock-grip')).toBeNull()
      let timerDragImage: Element | null = null
      fireEvent.dragStart(timerCards[1], { dataTransfer: { setDragImage: (image: Element) => { timerDragImage = image } } })
      timerCards = container.querySelectorAll<HTMLElement>('.clock-card')
      fireEvent.dragOver(timerCards[0], { dataTransfer: {} })
      expect(container.querySelectorAll<HTMLElement>('.clock-card')[0].classList.contains('drop-before')).toBe(true)
      await act(async () => {
        fireEvent.drop(container.querySelectorAll<HTMLElement>('.clock-card')[0], { dataTransfer: {} })
        await store.flush()
      })
      expect(store.state.timers.map((timer) => timer.id)).toEqual([secondTimer.id, firstTimer.id])
      expect((timerDragImage as Element | null)?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 512 512')

      fireEvent.click(screen.getByRole('tab', { name: 'Alarm' }))
      let alarmCards = container.querySelectorAll<HTMLElement>('.clock-row')
      expect(alarmCards).toHaveLength(2)
      expect(alarmCards[0].getAttribute('draggable')).toBe('true')
      expect(alarmCards[0].querySelector('.clock-grip')).toBeNull()
      let alarmDragImage: Element | null = null
      fireEvent.dragStart(alarmCards[1], { dataTransfer: { setDragImage: (image: Element) => { alarmDragImage = image } } })
      alarmCards = container.querySelectorAll<HTMLElement>('.clock-row')
      fireEvent.dragOver(alarmCards[0], { dataTransfer: {} })
      expect(container.querySelectorAll<HTMLElement>('.clock-row')[0].classList.contains('drop-before')).toBe(true)
      await act(async () => {
        fireEvent.drop(container.querySelectorAll<HTMLElement>('.clock-row')[0], { dataTransfer: {} })
        await store.flush()
      })
      expect(store.state.alarms.map((alarm) => alarm.id)).toEqual([secondAlarm.id, firstAlarm.id])
      expect((alarmDragImage as Element | null)?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    })
  })
})


describe('clock surface restoration', () => {
  it('describes command inputs and parses CLI timer and alarm arguments before execution', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'clock' } })
    const off = register(mock.api)
    expect(mock.commands.filter((command) => command.input && !command.input.schema).map((command) => command.id)).toEqual([])
    const timer = mock.commands.find((command) => command.id === 'timer-start')!
    const timerInput = timer.input!.fromCli!(['5m'], { label: 'Tea' })
    expect(timer.input!.parse(timerInput)).toEqual({ seconds: 300, label: 'Tea' })
    const result = await mock.api.commands.execute('clock:timer-start', timerInput)
    expect(result.ok).toBe(true)
    expect((await mock.api.data.dataset('timers').query({ limit: 10 })).rows).toContainEqual(expect.objectContaining({ label: 'Tea', duration: 300000 }))
    const alarm = mock.commands.find((command) => command.id === 'alarm-add')!
    expect(alarm.input!.parse(alarm.input!.fromCli!(['08:45'], { days: 'mon,tue' }))).toMatchObject({ hour: 8, minute: 45, days: [1, 2] })
    off()
  })

  it('restores the selected paused timer without restarting it or exposing Properties', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'clock' } })
    const off = register(mock.api)
    const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
    await store.ready
    const timer = store.addTimer(90, 'Tea')!
    store.pauseTimer(timer.id)
    await store.flush()
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'right_sidebar')!.extension
    await surface.restore({ mode: 'timer', timerId: timer.id }, undefined, { background: true })
    expect(store.state.timers[0].running).toBe(false)
    expect(mock.api.workspace.revealOwnPanel).not.toHaveBeenCalled()
    expect(surface.getSnapshot().item?.state).toEqual({ mode: 'timer', timerId: timer.id })
    expect(mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)).toEqual([])
    expect(mock.api.commands.list().some((command) => command.id === 'clock:properties-edit')).toBe(false)
    await expect(surface.restore({ mode: 'alarm', alarmId: 'deleted' })).rejects.toThrow('no longer available')
    off()
  })

  it('does not expose a World clock city as a Properties item', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'clock' } })
    const off = register(mock.api)
    const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
    await store.ready
    store.worldAdd('Tokyo')
    store.state.mode = 'clock'
    store.state.selectedCity = 'Asia/Tokyo'
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'right_sidebar')!.extension
    expect(surface.getSnapshot().item).toBeUndefined()
    off()
  })
})
