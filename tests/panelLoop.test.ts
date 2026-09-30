import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react'
import { clockNeedsAnimation, type AnimState } from '../src/index'
import { createMockValleyApi } from './harness'

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
  let hidden = false
  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  async function mount(settings = {}, container?: HTMLElement) {
    const mod = await import('../src/index')
    const mock = createMockValleyApi({ settings: { seconds: true, ...settings } })
    const dispose = mod.register(mock.api)
    const entry = vi.mocked(mock.api.registerView).mock.calls.find(([id]) => id === 'clock.panel')!
    const mounted = render(React.createElement(entry[1] as React.FC), container ? { container, baseElement: container } : undefined)
    await act(async () => { await Promise.resolve() })
    return { ...mounted, dispose, mock }
  }

  it('moves the second hand without animation frames, including the last second of a minute', async () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:59.000Z'))
    const { container, dispose } = await mount()
    const hand = () => container.querySelector('.clock-face circle[fill="var(--accent-color)"]')?.getAttribute('cx')
    const before = hand()
    act(() => vi.advanceTimersByTime(500))
    expect(hand()).not.toBe(before)
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['digital', 'analog'])('updates the %s stopwatch every 3ms without rerendering the panel and pauses when hidden', async stopwatchDisplay => {
    const { container, dispose, mock, unmount } = await mount({ stopwatchDisplay })
    fireEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))
    fireEvent.click(screen.getByText('Start'))
    const readout = () => container.querySelector('.clock-readout')?.textContent
    const settingsRead = vi.spyOn(mock.api.settings, 'get')
    const store = mock.api.runtime.getOrCreate<import('../src/store').ClockStore>('clock.store', () => { throw new Error('Missing store') })
    const elapsed = vi.spyOn(store, 'swElapsed')
    expect(readout()).toBe('00:00.00')
    act(() => vi.advanceTimersByTime(2))
    expect(elapsed).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(elapsed).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(9))
    expect(readout()).toBe('00:00.01')
    act(() => vi.advanceTimersByTime(9))
    expect(readout()).toBe('00:00.02')
    expect(settingsRead).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
    expect(vi.getTimerCount()).toBe(0)
    elapsed.mockClear()
    act(() => vi.advanceTimersByTime(1000))
    expect(elapsed).not.toHaveBeenCalled()
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
    expect(readout()).toBe('00:01.02')
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(screen.getByText('Stop'))
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(50))
    expect(readout()).toBe('00:01.02')
    fireEvent.click(screen.getByText('Start'))
    fireEvent.click(screen.getByRole('tab', { name: 'Pomodoro' }))
    expect(vi.getTimerCount()).toBe(0)
    elapsed.mockClear()
    act(() => vi.advanceTimersByTime(500))
    expect(elapsed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))
    expect(readout()).toBe('00:01.52')
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    elapsed.mockClear()
    act(() => vi.advanceTimersByTime(500))
    expect(elapsed).not.toHaveBeenCalled()
    dispose()
  })

  it('uses the visible surface window for its timer and visibility, not the hidden controller', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const surface = frame.contentDocument!
    const view = frame.contentWindow!
    const container = surface.createElement('div')
    surface.body.append(container)
    let surfaceHidden = false
    Object.defineProperty(surface, 'hidden', { configurable: true, get: () => surfaceHidden })
    hidden = true
    const start = vi.spyOn(view, 'setInterval')
    const stop = vi.spyOn(view, 'clearInterval')
    const { getByRole, getByText, unmount, dispose } = await mount({ stopwatchDisplay: 'digital' }, container)
    fireEvent.click(getByRole('tab', { name: 'Stopwatch' }))
    fireEvent.click(getByText('Start'))
    expect(start).toHaveBeenCalledWith(expect.any(Function), 3)
    const timer = start.mock.results.at(-1)!.value
    act(() => { surfaceHidden = true; surface.dispatchEvent(new Event('visibilitychange')) })
    expect(stop).toHaveBeenCalledWith(timer)
    act(() => { surfaceHidden = false; surface.dispatchEvent(new Event('visibilitychange')) })
    expect(start).toHaveBeenCalledTimes(2)
    unmount()
    expect(stop).toHaveBeenCalledWith(start.mock.results.at(-1)!.value)
    dispose()
    frame.remove()
  })

  it('stops while idle or hidden and restarts on notification or visibility', async () => {
    const { unmount, dispose } = await mount()
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByText('Start'))
    expect(vi.getTimerCount()).toBe(1)
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) })
    expect(vi.getTimerCount()).toBe(0)
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) })
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(screen.getByText('Stop'))
    expect(vi.getTimerCount()).toBe(0)
    unmount(); dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
