// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeShown, whileVisible } from '../src/visibility'

describe('whileVisible', () => {
  let hidden = false
  const setHidden = (value: boolean): void => { hidden = value; document.dispatchEvent(new Event('visibilitychange')) }
  beforeEach(() => { hidden = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden }); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); delete (document as { hidden?: boolean }).hidden })

  it('ticks while shown, arms nothing while hidden and refreshes when shown again', () => {
    const tick = vi.fn()
    const stop = whileVisible(tick, 1000)
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(3)
    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(tick).toHaveBeenCalledTimes(3)
    setHidden(false)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also stops while its element is off screen in a visible window, through one IntersectionObserver (GODS G6)', () => {
    const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnect: ReturnType<typeof vi.fn> }> = []
    class FakeObserver {
      disconnect = vi.fn()
      constructor(public callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(this) }
      observe(): void {}
    }
    const original = (window as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver
    try {
      const element = document.createElement('div')
      const tick = vi.fn()
      const stop = whileVisible(tick, 1000, element)
      expect(observers).toHaveLength(1)
      vi.advanceTimersByTime(2000)
      expect(tick).toHaveBeenCalledTimes(2)
      observers[0].callback([{ isIntersecting: false }])
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(10_000)
      expect(tick).toHaveBeenCalledTimes(2)
      observers[0].callback([{ isIntersecting: true }])
      vi.advanceTimersByTime(1000)
      expect(tick).toHaveBeenCalledTimes(3)
      setHidden(true)
      expect(vi.getTimerCount()).toBe(0)
      setHidden(false)
      const states: boolean[] = []
      const off = observeShown(element, shown => states.push(shown))
      observers[1].callback([{ isIntersecting: false }])
      observers[1].callback([{ isIntersecting: false }])
      expect(states).toEqual([true, false])
      off(); stop()
      expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { (window as { IntersectionObserver?: unknown }).IntersectionObserver = original }
  })
})
