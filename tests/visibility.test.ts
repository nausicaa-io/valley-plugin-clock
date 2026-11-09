// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whileVisible } from '../src/visibility'

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
})
