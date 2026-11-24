import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockValleyApi } from './harness'
import { register } from '../src/index'
import { fmtSpan, parseClockFence, parseCountdownDate, wallClockIn } from '../src/fence'
import codeBlockExamples from '../src/codeBlockExamples.json'

const roots: Array<() => void> = []
afterEach(() => {
  roots.splice(0).forEach(unmount => unmount())
  cleanup()
  document.body.innerHTML = ''
})

function mountFence(code: string, settings: Record<string, unknown> = {}) {
  const mock = createMockValleyApi({ manifest: { id: 'clock' }, settings })
  mock.api.ui.renderReact = ((el: HTMLElement, node: Parameters<ReturnType<typeof createRoot>['render']>[0]) => {
    const root = createRoot(el)
    act(() => root.render(node))
    const unmount = (): void => act(() => root.unmount())
    roots.push(unmount)
    return unmount
  }) as typeof mock.api.ui.renderReact
  const dispose = register(mock.api)
  const render = mock.codeBlockRenderers.get('clock')
  if (!render) throw new Error('clock fence was not registered')
  const el = document.createElement('div')
  document.body.appendChild(el)
  render(code, el, { path: 'note.md', meta: null })
  return { mock, el, dispose }
}

describe('clock fence parsing', () => {
  it('reads an empty block as the local clock face with seconds', () => {
    expect(parseClockFence('')).toEqual({ kind: 'time', zone: null, seconds: true })
  })

  it('resolves cities, IANA zones and the seconds switch', () => {
    expect(parseClockFence('city: Tokyo')).toEqual({ kind: 'time', zone: 'Asia/Tokyo', seconds: true })
    expect(parseClockFence('Tokyo')).toEqual({ kind: 'time', zone: 'Asia/Tokyo', seconds: true })
    expect(parseClockFence('zone: Europe/Lisbon\nseconds: false')).toEqual({ kind: 'time', zone: 'Europe/Lisbon', seconds: false })
    expect(parseClockFence('city: Atlantis')).toEqual({ kind: 'error', message: 'Unknown city or time zone: Atlantis' })
    expect(parseClockFence('tz: Mars/Olympus')).toMatchObject({ kind: 'error' })
  })

  it('reads world clocks as a list or a comma-separated line and refuses unknown cities', () => {
    expect(parseClockFence('world:\n  - Zurich\n  - New York')).toEqual({ kind: 'world', zones: ['Europe/Zurich', 'America/New_York'] })
    expect(parseClockFence('world: London, Sydney')).toEqual({ kind: 'world', zones: ['Europe/London', 'Australia/Sydney'] })
    expect(parseClockFence('world:\n  - Zurich\n  - Nowhere')).toEqual({ kind: 'error', message: 'Unknown city or time zone: Nowhere' })
    expect(parseClockFence('world:')).toEqual({ kind: 'error', message: 'No cities listed.' })
  })

  it('reads timers with Clock durations and the 999 h limit', () => {
    expect(parseClockFence('timer: 25m\nlabel: Focus')).toEqual({ kind: 'timer', seconds: 1500, label: 'Focus' })
    expect(parseClockFence('timer: 1h30m')).toEqual({ kind: 'timer', seconds: 5400, label: '' })
    expect(parseClockFence('timer: 0:45')).toEqual({ kind: 'timer', seconds: 45, label: '' })
    expect(parseClockFence('timer: soon')).toMatchObject({ kind: 'error' })
    expect(parseClockFence('timer: 1000h')).toMatchObject({ kind: 'error' })
  })

  it('reads countdown dates in local time and refuses impossible ones', () => {
    expect(parseCountdownDate('2026-12-24 18:00')).toBe(new Date(2026, 11, 24, 18, 0, 0).getTime())
    expect(parseCountdownDate('2026-12-24T18:00:30')).toBe(new Date(2026, 11, 24, 18, 0, 30).getTime())
    expect(parseCountdownDate('2026-12-24')).toBe(new Date(2026, 11, 24).getTime())
    expect(parseCountdownDate('2026-02-30')).toBeNull()
    expect(parseCountdownDate('24.12.2026')).toBeNull()
    expect(parseClockFence('countdown: 2026-12-24 18:00\nlabel: Christmas Eve'))
      .toEqual({ kind: 'countdown', at: new Date(2026, 11, 24, 18).getTime(), label: 'Christmas Eve' })
    expect(parseClockFence('countdown: tomorrow')).toMatchObject({ kind: 'error' })
  })

  it('formats spans with days only once there is a day left', () => {
    expect(fmtSpan(65_000)).toBe('01:05')
    expect(fmtSpan(3_725_000)).toBe('1:02:05')
    expect(fmtSpan(2 * 86_400_000 + 3_725_000)).toBe('2 d 01:02:05')
    expect(fmtSpan(86_399_500)).toBe('1 d 00:00:00')
  })

  it('reads the wall-clock time of another zone for the analog face', () => {
    const now = new Date(Date.UTC(2026, 5, 1, 12, 30, 15))
    const wall = wallClockIn('Asia/Tokyo', now)
    expect([wall.getHours(), wall.getMinutes(), wall.getSeconds()]).toEqual([21, 30, 15])
  })

  it('ships examples that all parse', () => {
    for (const example of codeBlockExamples.clock) expect(parseClockFence(example.code).kind).not.toBe('error')
  })
})

describe('clock fence rendering', () => {
  it('claims the clock fence with its examples and releases it on dispose', () => {
    const { mock, dispose } = mountFence('')
    expect(mock.codeBlockRenderers.has('clock')).toBe(true)
    dispose()
    expect(mock.codeBlockRenderers.has('clock')).toBe(false)
  })

  it('draws the face with the city name and its time', () => {
    const { el } = mountFence('city: Tokyo')
    expect(el.querySelector('.clock-fence-face svg')).not.toBeNull()
    expect(screen.getByText('Tokyo')).toBeTruthy()
    expect(el.querySelector('.clock-readout')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('lists world clocks in the given order', () => {
    const { el } = mountFence('world:\n  - Zurich\n  - Tokyo')
    expect([...el.querySelectorAll('.clock-fence-title')].map(node => node.textContent)).toEqual(['Zürich', 'Tokyo'])
  })

  it('starts a real Clock timer and reveals the panel', async () => {
    const { mock, el } = mountFence('timer: 25m\nlabel: Focus')
    expect(el.textContent).toContain('25:00')
    expect(el.textContent).toContain('Focus')
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Timer started' })).toBeTruthy())
    const store = mock.api.runtime.getOrCreate<{ state: { timers: Array<{ label: string; duration: number }>; mode: string } }>('clock.store', () => { throw new Error('no store') })
    expect(store.state.timers).toEqual([expect.objectContaining({ label: 'Focus', duration: 1_500_000, running: true })])
    expect(store.state.mode).toBe('timer')
    expect(mock.api.workspace.revealOwnPanel).toHaveBeenCalledWith('right_sidebar')
  })

  it('shows no start button while timers are switched off', () => {
    const { el } = mountFence('timer: 5m', { showTimer: false })
    expect(el.querySelector('button')).toBeNull()
    expect(el.textContent).toContain('Timers are switched off in Clock settings.')
  })

  it('counts down to a date and reports a reached one', () => {
    const { el } = mountFence('countdown: 2999-01-01\nlabel: Far away')
    expect(el.textContent).toContain('Far away')
    expect(el.querySelector('.clock-readout')?.textContent).toMatch(/^\d+ d \d{2}:\d{2}:\d{2}$/)
    cleanup()
    const past = mountFence('countdown: 2000-01-01')
    expect(past.el.querySelector('.clock-readout.done')?.textContent).toBe('Reached')
  })

  it('shows a plain message for a block it cannot read', () => {
    const { el } = mountFence('city: Atlantis')
    expect(el.querySelector('.clock-fence-error')?.textContent).toBe('Unknown city or time zone: Atlantis')
  })
})
