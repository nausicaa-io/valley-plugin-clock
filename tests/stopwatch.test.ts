import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createStopwatch } from '../src/stopwatch'
import manifest from '../manifest.json'
import config from '../config.json'

const makeMock = () => createMockValleyApi({ manifest: { ...manifest, ...config } as unknown as ValleyPluginManifest })
function harness(mock = makeMock()) {
  let now = 1_000_000
  let api = mock.api
  const writes: Array<() => Promise<unknown>> = []
  const notify = vi.fn()
  const stopwatch = createStopwatch({ api: () => api, enqueue: write => { writes.push(write) }, now: () => now, notify })
  return { mock, stopwatch, writes, notify, time: (value: number) => { now = value }, api: (value: typeof api) => { api = value }, flush: async () => { while (writes.length) await writes.shift()!() } }
}
afterEach(() => vi.restoreAllMocks())

describe('stopwatch owner', () => {
  it('derives running and paused time across sleep, restart, and backwards clock movement without tick writes', async () => {
    const h = harness()
    h.stopwatch.start()
    h.time(1_060_000)
    h.stopwatch.lap()
    h.time(1_090_000)
    expect(h.stopwatch.elapsed()).toBe(90_000)
    await h.flush()
    const restored = harness(h.mock)
    restored.time(1_100_000)
    await restored.stopwatch.load()
    expect(restored.stopwatch.elapsed()).toBe(100_000)
    expect(restored.stopwatch.state.laps).toEqual([60_000])
    restored.stopwatch.stop()
    restored.time(9_000_000)
    expect(restored.stopwatch.elapsed()).toBe(100_000)
    restored.stopwatch.start()
    restored.time(8_000_000)
    expect(restored.stopwatch.elapsed()).toBe(100_000)
    const writes = restored.writes.length
    const notifications = restored.notify.mock.calls.length
    for (let tick = 0; tick < 1000; tick++) { restored.time(9_000_000 + tick * 100); expect(restored.stopwatch.elapsed()).toBe(100_000 + tick * 100) }
    expect(restored.writes).toHaveLength(writes)
    expect(restored.notify).toHaveBeenCalledTimes(notifications)
    await restored.flush()
  })

  it('captures each lap snapshot and originating API before queued transactions start', async () => {
    const h = harness()
    const other = makeMock()
    h.stopwatch.start()
    h.time(1_010_000)
    h.stopwatch.lap()
    h.time(1_025_000)
    h.stopwatch.lap()
    h.stopwatch.stop()
    h.api(other.api)
    await h.writes.shift()!()
    expect((await h.mock.api.data.dataset('stopwatch_laps').query({ limit: 10 })).rows).toEqual([])
    await h.writes.shift()!()
    expect((await h.mock.api.data.dataset('stopwatch_laps').query({ limit: 10 })).rows.map(row => row.elapsed)).toEqual([10_000])
    await h.flush()
    expect((await h.mock.api.data.dataset('stopwatch_laps').query({ limit: 10 })).rows.map(row => row.elapsed)).toEqual([25_000, 10_000])
    expect(await h.mock.api.data.dataset('stopwatch_state').get({ id: 'stopwatch' })).toMatchObject({ running: false, elapsed: 25_000, startedAt: 0 })
    expect(await other.api.data.dataset('stopwatch_state').get({ id: 'stopwatch' })).toBeNull()
  })

  it('restores and resets laps beyond one dataset page through the owning writer', async () => {
    const h = harness()
    h.stopwatch.start()
    for (let lap = 1; lap <= 1001; lap++) { h.time(1_000_000 + lap); h.stopwatch.lap() }
    const latest = h.writes.pop()!
    h.writes.length = 0
    await latest()
    const restored = harness(h.mock)
    await restored.stopwatch.load()
    expect(restored.stopwatch.state.laps).toEqual(Array.from({ length: 1001 }, (_, index) => 1001 - index))
    restored.stopwatch.reset()
    await restored.flush()
    expect((await h.mock.api.data.dataset('stopwatch_laps').query({ limit: 1000 })).rows).toEqual([])
    expect(await h.mock.api.data.dataset('stopwatch_state').get({ id: 'stopwatch' })).toMatchObject({ running: false, elapsed: 0, startedAt: 0 })
  })

  it.each(['edit', 'api'] as const)('discards a late hydration after a newer %s', async cause => {
    const saved = harness()
    saved.stopwatch.start()
    saved.time(1_050_000)
    saved.stopwatch.stop()
    await saved.flush()
    const h = harness(saved.mock)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dataset = h.mock.api.data.dataset
    vi.spyOn(h.mock.api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      return id === 'stopwatch_state' ? { ...value, get: async key => { const record = await value.get(key); await gate; return record } } : value
    })
    const loading = h.stopwatch.load()
    if (cause === 'edit') h.stopwatch.start()
    else h.api(makeMock().api)
    release()
    await loading
    expect(h.stopwatch.state).toMatchObject({ elapsed: 0, laps: [], running: cause === 'edit' })
    await h.flush()
  })

  it('retires failed hydration on unload and resumes once without the stale result', async () => {
    const saved = harness()
    saved.stopwatch.start()
    saved.time(1_030_000)
    saved.stopwatch.stop()
    await saved.flush()
    const h = harness(saved.mock)
    const releases: Array<() => void> = []
    const dataset = h.mock.api.data.dataset
    vi.spyOn(h.mock.api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      return id === 'stopwatch_state' ? { ...value, get: async key => {
        const attempt = releases.length
        await new Promise<void>(resolve => releases.push(resolve))
        if (attempt === 0) throw new Error('Retired request')
        return value.get(key)
      } } : value
    })
    const first = h.stopwatch.load()
    h.stopwatch.suspend()
    const second = h.stopwatch.resumeLoading()
    releases[0]()
    await first
    expect(h.notify).not.toHaveBeenCalled()
    releases[1]()
    await second
    expect(h.stopwatch.elapsed()).toBe(30_000)
    expect(h.notify).toHaveBeenCalledOnce()
    h.stopwatch.suspend()
    await h.stopwatch.resumeLoading()
    expect(releases).toHaveLength(2)
  })
})
