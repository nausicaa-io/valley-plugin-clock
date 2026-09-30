import { readClockFile } from '../src/persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './harness'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createPomodoro } from '../src/pomodoro'
import { register, type ClockStore } from '../src/index'
import manifest from '../manifest.json'
import config from '../config.json'

const makeMock = (settings: Record<string, unknown> = {}) => createMockValleyApi({ manifest: { ...manifest, ...config } as unknown as ValleyPluginManifest, settings: { pomodoroWork: 1, pomodoroShort: 0.5, pomodoroLong: 2, pomodoroCycles: 2, ...settings } })
function harness(mock = makeMock()) {
  let now = 1_000_000
  let api = mock.api
  let sequence = 0
  const writes: Array<() => Promise<unknown>> = []
  const sounds: Array<{ stop: ReturnType<typeof vi.fn> }> = []
  const sound = vi.fn(() => { const playback = { stop: vi.fn() }; sounds.push(playback); return playback })
  const notify = vi.fn()
  const pomodoro = createPomodoro({ api: () => api, enqueue: write => { writes.push(write) }, now: () => now, id: () => `profile-${++sequence}`, notify, sound, title: () => 'Pomodoro', phaseName: phase => phase, persistenceError: () => new Error('Rejected profile write') })
  return { mock, pomodoro, writes, notify, sounds, sound, time: (value: number) => { now = value }, api: (value: typeof api) => { api = value }, flush: async () => { while (writes.length) await writes.shift()!() } }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Pomodoro owner', () => {
  it('advances due phases once, retains the long-break cycle, and performs no persistence on display ticks', async () => {
    const h = harness()
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    h.pomodoro.start()
    expect(schedule).toHaveBeenLastCalledWith('pomodoro', [1_060_000], { eventId: 'pomodoro', title: 'Pomodoro', body: 'short' })
    const writes = h.writes.length
    const notifications = h.notify.mock.calls.length
    for (let tick = 0; tick < 1000; tick++) { h.time(1_000_000 + tick); expect(h.pomodoro.remaining()).toBe(60_000 - tick) }
    h.pomodoro.ring()
    expect(h.writes).toHaveLength(writes)
    expect(h.notify).toHaveBeenCalledTimes(notifications)
    expect(h.sound).not.toHaveBeenCalled()
    for (const [phase, cycle, duration] of [['short', 1, 30_000], ['work', 1, 60_000], ['long', 0, 120_000], ['work', 0, 60_000]] as const) {
      const deadline = h.pomodoro.state.endsAt
      h.time(deadline)
      h.pomodoro.ring()
      expect(h.pomodoro.state).toMatchObject({ phase, cycle, remaining: duration, endsAt: deadline + duration, running: true })
      const count = h.sound.mock.calls.length
      h.pomodoro.ring()
      expect(h.sound).toHaveBeenCalledTimes(count)
    }
    expect(h.sound).toHaveBeenCalledTimes(4)
    expect(schedule).toHaveBeenCalledTimes(5)
    expect(h.sounds.slice(0, -1).every(sound => sound.stop.mock.calls.length === 1)).toBe(true)
    await h.flush()
  })

  it('restores future deadlines, expired zero, and paused zero without announcing a phase during hydration', async () => {
    const h = harness()
    h.pomodoro.start()
    await h.flush()
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    const future = harness(h.mock)
    future.time(1_020_000)
    await future.pomodoro.load()
    expect(future.pomodoro.state).toMatchObject({ running: true, remaining: 40_000, endsAt: 1_060_000 })
    expect(schedule).toHaveBeenCalledOnce()
    schedule.mockClear()
    const expired = harness(h.mock)
    expired.time(2_000_000)
    await expired.pomodoro.load()
    expect(expired.pomodoro.state).toMatchObject({ phase: 'short', cycle: 0, running: false, remaining: 30000, endsAt: 0 })
    expect(schedule).not.toHaveBeenCalled()
    expect(expired.sound).not.toHaveBeenCalled()
    future.time(1_060_000)
    future.pomodoro.pause()
    await future.flush()
    const paused = harness(h.mock)
    await paused.pomodoro.load()
    expect(paused.pomodoro.state).toMatchObject({ running: false, remaining: 0 })
    paused.pomodoro.start()
    expect(paused.pomodoro.remaining()).toBe(60_000)
    await paused.flush()
  })

  it('preserves remaining time over a paused interval and rejects rings after reset or skip', async () => {
    const h = harness()
    h.pomodoro.start()
    h.time(1_015_000)
    h.pomodoro.pause()
    h.time(2_000_000)
    expect(h.pomodoro.remaining()).toBe(45_000)
    h.pomodoro.ring()
    expect(h.sound).not.toHaveBeenCalled()
    h.pomodoro.start()
    expect(h.pomodoro.state.endsAt).toBe(2_045_000)
    h.time(2_045_000)
    h.pomodoro.ring()
    h.pomodoro.skip()
    expect(h.sounds[0].stop).toHaveBeenCalledOnce()
    expect(h.pomodoro.state).toMatchObject({ phase: 'work', running: true, endsAt: 2_105_000 })
    h.pomodoro.ring()
    expect(h.sound).toHaveBeenCalledOnce()
    h.pomodoro.reset()
    h.time(3_000_000)
    h.pomodoro.ring()
    expect(h.pomodoro.state).toMatchObject({ phase: 'work', cycle: 0, remaining: 60_000, running: false })
    expect(h.sound).toHaveBeenCalledOnce()
    await h.flush()
  })

  it('retains profile ordering, spaces during edits, active selection and paused duration across restart', async () => {
    const h = harness()
    const second = h.pomodoro.addProfile(' Deep work ')
    const third = h.pomodoro.addProfile()
    expect(second.name).toBe('Deep work')
    expect(third.name).toBe('Pomodoro 3')
    h.pomodoro.renameProfile(second.id, ' Deep ')
    expect(second.name).toBe(' Deep ')
    h.pomodoro.renameProfile(second.id, ' Deep ', true)
    h.pomodoro.updateProfile(second.id, { work: 7, short: 2, cycles: 3.8 })
    expect(h.pomodoro.moveProfile(1, 0)).toBe(true)
    h.pomodoro.selectProfile(second.id)
    h.pomodoro.updateProfile(second.id, { work: 8 })
    await h.flush()
    const restored = harness(h.mock)
    await restored.pomodoro.load()
    expect(restored.pomodoro.profiles.map(profile => profile.id)).toEqual([second.id, 'focus', third.id])
    expect(restored.pomodoro.profileId).toBe(second.id)
    expect(restored.pomodoro.config()).toEqual({ work: 8, short: 2, long: 2, cycles: 4 })
    expect(restored.pomodoro.state.remaining).toBe(8 * 60_000)
    restored.pomodoro.removeProfile(second.id)
    expect(restored.pomodoro.profileId).toBe('focus')
    restored.pomodoro.removeProfile(third.id)
    restored.pomodoro.removeProfile('focus')
    expect(restored.pomodoro.profiles.map(profile => profile.id)).toEqual(['focus'])
    await restored.flush()
  })

  it('captures profile/config and session writes before the API or live state changes', async () => {
    const h = harness()
    const other = makeMock()
    const set = vi.spyOn(h.mock.api.settings, 'set')
    const second = h.pomodoro.addProfile('First name')
    h.pomodoro.updateProfile(second.id, { work: 9 })
    h.pomodoro.renameProfile(second.id, 'Latest name')
    h.pomodoro.start()
    h.api(other.api)
    await h.flush()
    const snapshots = set.mock.calls.filter(([key]) => key === 'pomodoroProfiles').map(([, value]) => JSON.parse(String(value)))
    expect(snapshots.map(profiles => profiles[1].name)).toEqual(['First name', 'First name', 'Latest name'])
    expect(snapshots.map(profiles => profiles[1].work)).toEqual([1, 9, 9])
    expect(set.mock.calls.filter(([key]) => key === 'pomodoroWork').map(([, value]) => value)).toEqual([1, 9])
    expect(h.mock.api.settings.get().pomodoroActiveProfile).toBe(second.id)
    expect(other.api.settings.get().pomodoroProfiles).toBeUndefined()
    expect(await readClockFile<Record<string, unknown>>(other.api, 'pomodoro.json')).toBeNull()
    expect(await readClockFile<Record<string, unknown>>(h.mock.api, 'pomodoro.json')).toMatchObject({ running: true, endsAt: 1_540_000, remaining: 540_000 })
  })

  it.each(['edit', 'api'] as const)('discards delayed session hydration after a newer %s', async cause => {
    const saved = harness()
    saved.pomodoro.start()
    await saved.flush()
    const h = harness(saved.mock)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = h.mock.api.data.files.readText
    vi.spyOn(h.mock.api.data.files, 'readText').mockImplementation(async path => {
      if (path !== 'pomodoro.json') return read(path)
      const record = await read(path); await gate; return record
    })
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    const loading = h.pomodoro.load()
    if (cause === 'edit') h.pomodoro.skip()
    else h.api(makeMock().api)
    release()
    await loading
    expect(h.pomodoro.state).toMatchObject({ phase: cause === 'edit' ? 'short' : 'work', running: false, endsAt: 0 })
    expect(schedule).not.toHaveBeenCalled()
    await h.flush()
  })

  it('suspends in-flight loading and sound without cancelling host deadlines, then resumes hydration once', async () => {
    const saved = harness()
    saved.pomodoro.start()
    await saved.flush()
    const h = harness(saved.mock)
    const releases: Array<() => void> = []
    const read = h.mock.api.data.files.readText
    vi.spyOn(h.mock.api.data.files, 'readText').mockImplementation(async path => {
      if (path !== 'pomodoro.json') return read(path)
      const attempt = releases.length
        await new Promise<void>(resolve => releases.push(resolve))
        if (attempt === 0) throw new Error('Retired read')
        return read(path)
    })
    const first = h.pomodoro.load()
    h.pomodoro.suspend()
    const second = h.pomodoro.resumeLoading()
    releases[0]()
    await first
    expect(h.notify).not.toHaveBeenCalled()
    releases[1]()
    await second
    h.time(1_060_000)
    h.pomodoro.ring()
    expect(h.sound).toHaveBeenCalledOnce()
    const cancel = vi.spyOn(h.mock.api.notifications, 'cancel')
    h.pomodoro.suspend()
    h.pomodoro.suspend()
    expect(h.sounds[0].stop).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    h.time(2_000_000)
    h.pomodoro.ring()
    expect(h.sound).toHaveBeenCalledOnce()
    await h.pomodoro.resumeLoading()
    expect(releases).toHaveLength(2)
    h.pomodoro.ring()
    expect(h.sound).toHaveBeenCalledTimes(2)
    await h.flush()
  })

  it('reports failed mirrored setting writes through the shared persistence queue', async () => {
    const h = harness()
    vi.spyOn(h.mock.api.settings, 'set').mockResolvedValue({ ok: false })
    h.pomodoro.addProfile()
    await expect(h.flush()).rejects.toThrow('Rejected profile write')
  })
})

it('receives one-shot phase changes from the backend without renderer notification audio', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('AudioContext', class {
    currentTime = 0
    destination = {}
    close = vi.fn(async () => {})
    suspend = vi.fn(async () => {})
    resume = vi.fn(async () => {})
    constructor() { contexts.push(this) }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} } }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } } }
  })
  const mock = makeMock()
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  try {
    await store.ready
    store.swStart()
    store.pomoStart()
    await store.flush()
    const ring = { key: 'pomodoro', eventId: 'pomodoro', title: 'Pomodoro', tick: 1 }
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect(contexts).toHaveLength(0)
    vi.setSystemTime(store.state.pomo.endsAt)
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect(contexts).toHaveLength(0)
    expect(store.state.pomo).toMatchObject({ phase: 'short', cycle: 1, running: true })
    const cancel = vi.spyOn(mock.api.notifications, 'cancel')
    dispose()
    expect(cancel).not.toHaveBeenCalled()
    vi.setSystemTime(store.state.pomo.endsAt)
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect(contexts).toHaveLength(0)
    await store.flush()
    expect(await readClockFile<Record<string, unknown>>(mock.api, 'pomodoro.json')).toMatchObject({ phase: 'work', running: true })
    expect(await readClockFile<Record<string, unknown>>(mock.api, 'stopwatch.json')).toMatchObject({ running: true, startedAt: 1_000_000 })
  } finally { dispose() }
})

it('keeps the backend advancing when a renderer notification subscription retires', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const mock = makeMock()
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  const old = store.listen(mock.api)
  const current = store.listen(mock.api)
  try {
    await store.ready
    store.pomoStart()
    await store.flush()
    old()
    const ring = { key: 'pomodoro', eventId: 'pomodoro', title: 'Pomodoro', tick: 1 }
    vi.setSystemTime(store.state.pomo.endsAt)
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect(store.state.pomo).toMatchObject({ phase: 'short', cycle: 1 })
    vi.setSystemTime(store.state.pomo.endsAt)
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect(store.state.pomo).toMatchObject({ phase: 'work', cycle: 1 })
    current()
    vi.setSystemTime(store.state.pomo.endsAt)
    mock.emitNotificationRing(ring)
    await mock.flushClock()
    expect((await mock.clockOwner().snapshot()).pomo.state).toMatchObject({ phase: 'long', cycle: 0 })
    await store.flush()
  } finally { current(); old(); dispose() }
})
