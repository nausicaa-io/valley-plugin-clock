import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { createTimers } from '../src/timers'
import { register, type ClockStore } from '../src/index'

function harness(mock = createMockValleyApi({ manifest: { id: 'clock' } })) {
  let now = 1_000_000
  let sequence = 0
  let currentApi = mock.api
  let pending: Promise<unknown> = Promise.resolve()
  const playback: Array<{ stop: ReturnType<typeof vi.fn> }> = []
  const sound = vi.fn(() => { const item = { stop: vi.fn() }; playback.push(item); return item })
  const notify = vi.fn()
  const timers = createTimers({
    api: () => currentApi, enqueue: write => { pending = pending.then(write) }, now: () => now,
    id: () => `timer-${++sequence}`, notify, sound, title: () => 'Timer',
    formatDuration: value => `${value}ms`, persistenceError: () => new Error('Persistence failed')
  })
  return { mock, timers, playback, sound, notify, time: (value: number) => { now = value }, flush: () => pending, api: (value: typeof currentApi) => { currentApi = value } }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('countdown owner', () => {
  it('keeps elapsed wall time accurate across sleep and pause/resume without ticking', async () => {
    const h = harness()
    const timer = h.timers.add(120, ' Fern ')!
    expect(timer.label).toBe('Fern')
    h.time(1_075_000)
    expect(h.timers.remaining(timer)).toBe(45_000)
    expect(h.timers.pause(timer.id)).toBe(true)
    h.time(2_000_000)
    expect(h.timers.remaining(timer)).toBe(45_000)
    expect(h.timers.resume(timer.id)).toBe(true)
    expect(timer.endsAt).toBe(2_045_000)
    h.time(2_100_000)
    expect(h.timers.remaining(timer)).toBe(0)
    h.timers.ring(timer.id, 1)
    expect(timer).toMatchObject({ running: false, remaining: 0 })
    await h.flush()
    expect(await h.mock.api.data.dataset('timers').get({ id: timer.id })).toMatchObject({ running: false, remaining: 0 })
  })

  it('restores paused, running and expired rows in saved order and re-arms only future deadlines', async () => {
    const h = harness()
    await h.mock.api.data.dataset('timers').batch([
      { operation: 'insert', values: { id: 'future', label: 'Tea', duration: 5000, endsAt: 1_003_000, remaining: 5000, running: true } },
      { operation: 'insert', values: { id: 'expired', label: '', duration: 5000, endsAt: 990_000, remaining: 5000, running: true } },
      { operation: 'insert', values: { id: 'paused', label: '', duration: 5000, endsAt: 990_000, remaining: 2000, running: false } }
    ])
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    await h.timers.load(['paused', 'future', 'paused', 'missing'])
    expect(h.timers.items.map(timer => timer.id)).toEqual(['paused', 'future', 'expired'])
    expect(h.timers.items.map(h.timers.remaining)).toEqual([2000, 3000, 0])
    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledWith('timer:future', [1_003_000], expect.objectContaining({ title: 'Tea', ring: { actions: ['stop'] } }))
    expect(h.sound).not.toHaveBeenCalled()
    const persisted = await h.mock.api.data.dataset('timers').get({ id: 'expired' })
    expect(persisted).toMatchObject({ running: true, remaining: 5000 })
  })

  it('stops the current sound on stop and ignores delayed repeats or rings for paused/deleted timers', async () => {
    const h = harness()
    const timer = h.timers.add(1)!
    h.timers.ring(timer.id, 1)
    expect(h.sound).not.toHaveBeenCalled()
    h.time(timer.endsAt)
    h.timers.ring(timer.id, 1)
    h.timers.ring(timer.id, 2)
    expect(h.playback[0].stop).toHaveBeenCalledOnce()
    h.timers.stop(timer.id)
    expect(h.playback[1].stop).toHaveBeenCalledOnce()
    h.timers.ring(timer.id, 3)
    expect(h.sound).toHaveBeenCalledTimes(2)
    h.timers.cancel(timer.id)
    h.timers.ring(timer.id, 4)
    const paused = h.timers.add(5)!
    h.timers.pause(paused.id)
    h.time(paused.endsAt + 1000)
    h.timers.ring(paused.id, 1)
    expect(h.sound).toHaveBeenCalledTimes(2)
    await h.flush()
  })

  it('cancels one timer sound independently and releases all sounds without cancelling host schedules', async () => {
    const h = harness()
    const first = h.timers.add(1)!
    const second = h.timers.add(1)!
    const future = h.timers.add(100)!
    h.time(first.endsAt)
    h.timers.ring(first.id, 1)
    h.timers.ring(second.id, 1)
    const cancel = vi.spyOn(h.mock.api.notifications, 'cancel')
    h.timers.cancel(first.id)
    expect(h.playback[0].stop).toHaveBeenCalledOnce()
    expect(h.playback[1].stop).not.toHaveBeenCalled()
    h.timers.stopSounds()
    h.timers.stopSounds()
    expect(h.playback[1].stop).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith(`timer:${first.id}`)
    expect(future.running).toBe(true)
    await h.flush()
  })

  it('captures ordered write snapshots and their originating API before queued writes run', async () => {
    const h = harness()
    const other = createMockValleyApi({ manifest: { id: 'clock' } })
    const timer = h.timers.add(30, 'First')!
    h.api(other.api)
    await h.flush()
    expect(await h.mock.api.data.dataset('timers').get({ id: timer.id })).toMatchObject({ label: 'First', running: true })
    expect(await other.api.data.dataset('timers').get({ id: timer.id })).toBeNull()
    h.api(h.mock.api)
    const second = h.timers.add(20, 'Second')!
    h.timers.pause(timer.id)
    h.timers.update(timer.id, { duration: 70_000, label: 'Updated' })
    h.timers.move(1, 0)
    await h.flush()
    expect(h.mock.api.settings.get().timerOrder).toBe(JSON.stringify([second.id, timer.id]))
    expect(await h.mock.api.data.dataset('timers').get({ id: timer.id })).toMatchObject({ label: 'Updated', duration: 70_000, remaining: 70_000, endsAt: 0, running: false })
  })

  it('rejects invalid durations and disallows changing a running deadline', async () => {
    const h = harness()
    for (const duration of [0, -1, Infinity, NaN]) expect(h.timers.add(duration)).toBeNull()
    const timer = h.timers.add(1)!
    expect(h.timers.update(timer.id, { duration: 2000 })).toBeNull()
    expect(h.timers.resume(timer.id)).toBe(false)
    expect(h.timers.move(1, 0)).toBe(false)
    expect(h.timers.items).toEqual([timer])
    await h.flush()
  })

  it.each([999, 1000, 1001])('restores and persists all %i timer rows across dataset pages', async count => {
    const h = harness()
    const records = Array.from({ length: count }, (_, index) => ({ id: `saved-${index}`, label: '', duration: 1000, endsAt: 0, remaining: 1000, running: false }))
    await h.mock.api.data.dataset('timers').batch(records.map(values => ({ operation: 'insert', values })))
    await h.timers.load([records.at(-1)!.id])
    expect(h.timers.items).toHaveLength(count)
    expect(h.timers.items[0].id).toBe(records.at(-1)!.id)
    h.timers.cancel('saved-0')
    await h.flush()
    const restored = createTimers({
      api: () => h.mock.api, enqueue: () => {}, now: () => 1_000_000, id: () => 'unused', notify: () => {},
      sound: () => null, title: () => 'Timer', formatDuration: String, persistenceError: () => new Error('Unexpected write')
    })
    await restored.load([])
    expect(restored.items).toHaveLength(count - 1)
    expect(restored.items.some(timer => timer.id === records.at(-1)!.id)).toBe(true)
  })

  it.each(['edit', 'api'] as const)('does not publish or re-arm delayed hydration after a newer %s', async cause => {
    const saved = harness()
    saved.timers.add(90, 'Saved')
    await saved.flush()
    const h = harness(saved.mock)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dataset = h.mock.api.data.dataset
    vi.spyOn(h.mock.api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      return id === 'timers' ? { ...value, query: async options => { const result = await value.query(options); await gate; return result } } : value
    })
    const other = createMockValleyApi({ manifest: { id: 'clock' } })
    const schedule = vi.spyOn(other.api.notifications, 'schedule')
    const loading = h.timers.load([])
    if (cause === 'edit') h.timers.add(15, 'New')
    else h.api(other.api)
    release()
    await loading
    expect(h.timers.items.map(timer => timer.label)).toEqual(cause === 'edit' ? ['New'] : [])
    expect(schedule).not.toHaveBeenCalled()
    await h.flush()
  })

  it('resumes retired hydration once with its captured order and ignores old request failures', async () => {
    const saved = harness()
    const firstTimer = saved.timers.add(90, 'First')!
    const secondTimer = saved.timers.add(120, 'Second')!
    await saved.flush()
    const h = harness(saved.mock)
    const releases: Array<() => void> = []
    const dataset = h.mock.api.data.dataset
    vi.spyOn(h.mock.api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      return id === 'timers' ? { ...value, query: async options => {
        const attempt = releases.length
        await new Promise<void>(resolve => releases.push(resolve))
        if (attempt === 0) throw new Error('Retired timer read')
        return value.query(options)
      } } : value
    })
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    const order = [secondTimer.id, firstTimer.id]
    const first = h.timers.load(order)
    order.reverse()
    h.timers.suspend()
    const second = h.timers.resumeLoading()
    releases[0]()
    await first
    expect(h.timers.items).toEqual([])
    expect(schedule).not.toHaveBeenCalled()
    releases[1]()
    await second
    expect(h.timers.items.map(timer => timer.id)).toEqual([secondTimer.id, firstTimer.id])
    expect(schedule).toHaveBeenCalledTimes(2)
    h.timers.suspend()
    h.time(2_000_000)
    h.timers.ring(firstTimer.id, 1)
    expect(h.sound).not.toHaveBeenCalled()
    await h.timers.resumeLoading()
    expect(releases).toHaveLength(2)
  })

  it('stops requesting subsequent dataset pages once hydration is retired', async () => {
    const saved = harness()
    saved.timers.add(90, 'First')
    saved.timers.add(120, 'Second')
    await saved.flush()
    const h = harness(saved.mock)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dataset = h.mock.api.data.dataset
    const query = vi.fn(async (options: Parameters<ReturnType<typeof dataset>['query']>[0]) => {
      const page = await dataset('timers').query({ ...options, limit: 1 })
      await gate
      return page
    })
    vi.spyOn(h.mock.api.data, 'dataset').mockImplementation(id => id === 'timers' ? { ...dataset(id), query } : dataset(id))
    const loading = h.timers.load([])
    h.timers.suspend()
    release()
    await loading
    expect(query).toHaveBeenCalledOnce()
    expect(h.timers.items).toEqual([])
    expect(h.notify).not.toHaveBeenCalled()
  })
})

it('does not hydrate or arm timers after the registering plugin has unloaded', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const saved = harness()
  saved.timers.add(90, 'Saved')
  await saved.flush()
  const mock = saved.mock
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const dataset = mock.api.data.dataset
  vi.spyOn(mock.api.data, 'dataset').mockImplementation(id => {
    const value = dataset(id)
    return id === 'timers' ? { ...value, query: async options => { const result = await value.query(options); await gate; return result } } : value
  })
  const schedule = vi.spyOn(mock.api.notifications, 'schedule')
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  dispose()
  release()
  await store.ready
  expect(store.state.timers).toEqual([])
  expect(schedule).not.toHaveBeenCalled()
})

it('wires host Stop and plugin unload to the actual synthesised playback while keeping future timers armed', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('AudioContext', class {
    currentTime = 0
    destination = {}
    close = vi.fn(async () => {})
    constructor() { contexts.push(this) }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} } }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } } }
  })
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  try {
    await store.ready
    const timer = store.addTimer(1)!
    const future = store.addTimer(100)!
    vi.setSystemTime(timer.endsAt)
    const ring = { key: `timer:${timer.id}`, eventId: 'timer', title: 'Timer', tick: 1 }
    mock.emitNotificationRing(ring)
    expect(contexts).toHaveLength(1)
    mock.emitNotificationAction({ ...ring, action: 'stop' })
    expect(contexts[0].close).toHaveBeenCalledOnce()
    mock.emitNotificationRing({ ...ring, tick: 2 })
    expect(contexts).toHaveLength(1)
    const next = store.addTimer(1)!
    vi.setSystemTime(next.endsAt)
    mock.emitNotificationRing({ ...ring, key: `timer:${next.id}` })
    expect(contexts).toHaveLength(2)
    const cancel = vi.spyOn(mock.api.notifications, 'cancel')
    dispose()
    expect(contexts[1].close).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    expect(future.running).toBe(true)
    mock.emitNotificationRing({ ...ring, key: `timer:${next.id}`, tick: 2 })
    expect(contexts).toHaveLength(2)
    await store.flush()
  } finally { dispose() }
})

it('awaits queued timer writes during unload, including writes added while the first is pending', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  const writes: Array<() => void> = []
  const originalSet = mock.api.settings.set
  vi.spyOn(mock.api.settings, 'set').mockImplementation(async (key, value) => {
    if (key === 'timerOrder') await new Promise<void>(resolve => writes.push(resolve))
    return originalSet(key, value)
  })
  const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }
  try {
    await store.ready
    const first = store.addTimer(30, 'First')!
    let finished = false
    const unloading = mock.runBeforeUnload().then(() => { finished = true })
    await settle()
    expect(writes).toHaveLength(1)
    expect(finished).toBe(false)
    const second = store.addTimer(45, 'Second')!
    writes[0]()
    await settle()
    expect(writes).toHaveLength(2)
    expect(finished).toBe(false)
    writes[1]()
    await unloading
    expect(finished).toBe(true)
    expect((await mock.api.data.dataset('timers').query({ limit: 10 })).rows.map(row => row.id)).toEqual([first.id, second.id])
    expect(mock.api.settings.get().timerOrder).toBe(JSON.stringify([first.id, second.id]))
  } finally { for (const release of writes) release(); await store.flush(); dispose() }
})

it('includes captured tab-order writes in unload even after the API and input order change', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const other = createMockValleyApi({ manifest: { id: 'clock' } })
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const set = mock.api.settings.set
  vi.spyOn(mock.api.settings, 'set').mockImplementation(async (key, value) => {
    if (key === 'tabOrder') await gate
    return set(key, value)
  })
  try {
    await store.ready
    const order: Parameters<ClockStore['setTabOrder']>[0] = ['timer', 'clock']
    store.setTabOrder(order)
    order.reverse()
    store.setApi(other.api)
    let finished = false
    const flushing = mock.runBeforeUnload().then(() => { finished = true })
    for (let tick = 0; tick < 30; tick++) await Promise.resolve()
    expect(finished).toBe(false)
    store.setTabOrder(['alarm', 'clock'])
    expect(other.api.settings.get().tabOrder).toBeUndefined()
    release()
    await flushing
    expect(mock.api.settings.get().tabOrder).toBe(JSON.stringify(['timer', 'clock']))
    expect(other.api.settings.get().tabOrder).toBe(JSON.stringify(['alarm', 'clock']))
  } finally { release(); await store.flush(); dispose() }
})
