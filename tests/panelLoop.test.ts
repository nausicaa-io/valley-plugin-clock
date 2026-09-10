import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react'
import { clockNeedsAnimation, type AnimState } from '../src/index'
import { createMockValleyApi } from '@valley/plugin-testkit'

// The clock panel used to re-render its whole SVG on *every* animation frame
// (60-120Hz) forever while mounted — pinning the renderer, GPU and compositor and
// cooking the machine. These tests lock in the gated + throttled loop: it runs
// only while something actually moves, caps to ~30fps, and pauses when hidden.

const st = (
  mode: AnimState['mode'],
  swRunning = false,
  anyTimerRunning = false,
  pomoRunning = false
): AnimState => ({ mode, swRunning, anyTimerRunning, pomoRunning })

describe('clockNeedsAnimation (loop gate)', () => {
  it('animates in clock mode whenever the window is visible', () => {
    expect(clockNeedsAnimation(st('clock'), false)).toBe(true)
  })

  it('never animates while the window is hidden (rAF is suspended anyway)', () => {
    expect(clockNeedsAnimation(st('clock'), true)).toBe(false)
    expect(clockNeedsAnimation(st('stopwatch', true), true)).toBe(false)
    expect(clockNeedsAnimation(st('timer', false, true), true)).toBe(false)
  })

  it('animates the stopwatch/timer/pomodoro only while they are running', () => {
    expect(clockNeedsAnimation(st('stopwatch'), false)).toBe(false)
    expect(clockNeedsAnimation(st('stopwatch', true), false)).toBe(true)
    expect(clockNeedsAnimation(st('timer'), false)).toBe(false)
    expect(clockNeedsAnimation(st('timer', false, true), false)).toBe(true)
    expect(clockNeedsAnimation(st('pomodoro'), false)).toBe(false)
    expect(clockNeedsAnimation(st('pomodoro', false, false, true), false)).toBe(true)
  })
})

describe('clock Panel render loop', () => {
  let pending: Map<number, FrameRequestCallback>
  let origRAF: typeof window.requestAnimationFrame
  let origCAF: typeof window.cancelAnimationFrame
  let hiddenVal: boolean

  beforeEach(() => {
    // The clock engine is anchored on `window` (survives hot reload); clear it so
    // each test gets a fresh store (mode/stopwatch/timer reset).
    delete (window as unknown as Record<string, unknown>).__valleyClockStore
    pending = new Map()
    let nextId = 0
    hiddenVal = false
    origRAF = window.requestAnimationFrame
    origCAF = window.cancelAnimationFrame
    // Deterministic rAF: frames fire only when we flush them, so we can observe
    // exactly when the loop schedules / stops.
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      const id = (nextId += 1)
      pending.set(id, cb)
      return id
    }) as typeof window.requestAnimationFrame
    window.cancelAnimationFrame = ((id: number): void => {
      pending.delete(id)
    }) as typeof window.cancelAnimationFrame
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenVal })
  })

  afterEach(() => {
    cleanup()
    window.requestAnimationFrame = origRAF
    window.cancelAnimationFrame = origCAF
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** Run every queued frame with timestamp `t` (each may schedule the next). */
  function flush(t: number): void {
    const cbs = [...pending.values()]
    pending.clear()
    act(() => {
      cbs.forEach((cb) => cb(t))
    })
  }

  async function mountFreshPanel(
    settings: Record<string, unknown> = { seconds: true }
  ): Promise<{ getSpy: ReturnType<typeof vi.spyOn> }> {
    // Fresh module per test: the clock keeps mode/stopwatch/timer at module scope,
    // so isolation requires a clean instance.
    vi.resetModules()
    const mod = await import('../src/index')
    const mock = createMockValleyApi({ settings })
    mod.default.register(mock.api)
    const registerView = mock.api.registerView as unknown as {
      mock: { calls: Array<[string, React.FC]> }
    }
    const entry = registerView.mock.calls.find((c) => c[0] === 'clock.panel')
    if (!entry) throw new Error('clock.panel view was not registered')
    const Panel = entry[1]
    const getSpy = vi.spyOn(mock.api.settings, 'get')
    render(React.createElement(Panel))
    return { getSpy }
  }

  it('schedules frames in clock mode but stops the moment the stopwatch is idle', async () => {
    await mountFreshPanel()
    // Clock mode: hands sweep continuously → the loop is running.
    expect(pending.size).toBe(1)

    // Switch to the (not-running) stopwatch → nothing moves → loop must wind down.
    fireEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))
    flush(1000) // process the in-flight frame; it must not reschedule
    expect(pending.size).toBe(0)
  })

  it('revives the loop when the stopwatch starts and stops it again when stopped', async () => {
    await mountFreshPanel()
    fireEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))
    flush(1000)
    expect(pending.size).toBe(0) // idle stopwatch → no frames

    fireEvent.click(screen.getByText('Start'))
    expect(pending.size).toBe(1) // running → loop revived

    fireEvent.click(screen.getByText('Stop'))
    flush(2000)
    expect(pending.size).toBe(0) // stopped → loop winds down
  })

  it('pauses while the window is hidden and resumes when it becomes visible', async () => {
    await mountFreshPanel()
    expect(pending.size).toBe(1) // clock mode → running

    hiddenVal = true
    document.dispatchEvent(new Event('visibilitychange'))
    flush(1000) // hidden → the in-flight frame must not reschedule
    expect(pending.size).toBe(0)

    hiddenVal = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pending.size).toBe(1) // shown again → loop resumes
  })

  it('throttles re-renders to ~30fps while animating', async () => {
    const { getSpy } = await mountFreshPanel()
    getSpy.mockClear() // ignore the initial mount render
    // 5 frames spanning 40ms (10ms apart). At a 30fps (~33ms) cap only the frames
    // at 1000 and 1040 cross the threshold — an unthrottled loop would render all 5.
    flush(1000)
    flush(1010)
    flush(1020)
    flush(1030)
    flush(1040)
    const renders = getSpy.mock.calls.length // one settings.get() read per render
    expect(renders).toBeGreaterThanOrEqual(1)
    expect(renders).toBeLessThanOrEqual(3)
  })
})
