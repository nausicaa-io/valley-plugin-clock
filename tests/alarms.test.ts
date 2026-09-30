import { readClockFile, writeClockFile } from '../src/persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, mockPreviewPlayback } from './harness'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createAlarms, nextOccurrences, type ClockAlarm } from '../src/alarms'
import { createSoundPlayer } from '../src/sounds'
import { register, type ClockStore } from '../src/index'
import manifest from '../manifest.json'
import config from '../config.json'

const declared = { ...manifest, ...config } as unknown as ValleyPluginManifest
const makeMock = () => createMockValleyApi({ manifest: declared })
function harness(mock = makeMock()) {
  let now = new Date(2026, 0, 1, 7).getTime()
  let api = mock.api
  let sequence = 0
  const writes: Array<() => Promise<unknown>> = []
  const sounds: Array<{ stop: ReturnType<typeof vi.fn> }> = []
  const sound = vi.fn(() => { const playback = { stop: vi.fn() }; sounds.push(playback); return playback })
  const notify = vi.fn()
  const removed = vi.fn()
  const alarms = createAlarms({ api: () => api, enqueue: write => { writes.push(write) }, now: () => now, id: () => `alarm-${++sequence}`, notify, removed, sound, title: () => 'Alarm', persistenceError: () => new Error('Rejected') })
  const flush = async () => { while (writes.length) await writes.shift()!() }
  return { mock, alarms, sounds, sound, notify, removed, writes, time: (value: number) => { now = value }, now: () => now, api: (value: typeof api) => { api = value }, flush }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('alarm owner', () => {
  it('persists custom song filenames alongside existing built-in alarms', async () => {
    const h = harness()
    const custom = h.alarms.add({ hour: 8, sound: 'file:Forest song.mp3' })
    const builtin = h.alarms.add({ hour: 9, sound: 'chime' })
    await h.flush()
    expect((await readClockFile<Array<Record<string, unknown>>>(h.mock.api, 'alarms.jsonl'))?.find(row => row.id === custom.id) ?? null).toMatchObject({ sound: 'file:Forest song.mp3' })
    const restored = harness(h.mock)
    await restored.alarms.load([custom.id, builtin.id])
    expect(restored.alarms.items.map(alarm => alarm.sound)).toEqual(['file:Forest song.mp3', 'chime'])
    restored.alarms.update(custom.id, { sound: 'bell' })
    await restored.flush()
    expect((await readClockFile<Array<Record<string, unknown>>>(h.mock.api, 'alarms.jsonl'))?.find(row => row.id === custom.id) ?? null).toMatchObject({ sound: 'bell' })
  })

  it('retains wall-clock schedules across real DST changes', () => {
    vi.stubEnv('TZ', 'Europe/Zurich')
    const alarm: ClockAlarm = { id: 'daily', hour: 7, minute: 30, label: '', sound: 'beep', enabled: true, days: [0, 1, 2, 3, 4, 5, 6] }
    const spring = nextOccurrences(alarm, 3, new Date(2026, 2, 27, 12))
    expect(spring.map(at => new Date(at).getTimezoneOffset())).toEqual([-60, -120, -120])
    expect(spring[1] - spring[0]).toBe(23 * 60 * 60_000)
    const autumn = nextOccurrences(alarm, 3, new Date(2026, 9, 23, 12))
    expect(autumn.map(at => new Date(at).getTimezoneOffset())).toEqual([-120, -60, -60])
    expect(autumn[1] - autumn[0]).toBe(25 * 60 * 60_000)
    expect([...spring, ...autumn].every(at => new Date(at).getHours() === 7 && new Date(at).getMinutes() === 30)).toBe(true)
  })

  it('advances a one-shot only once, stops the previous repetition and rejects late post-dismiss rings', async () => {
    const h = harness()
    const alarm = h.alarms.add({ hour: 8, minute: 0, sound: 'bell' })
    h.alarms.ring(alarm.id, 1)
    expect(h.sound).not.toHaveBeenCalled()
    h.time(new Date(2026, 0, 1, 8).getTime())
    h.alarms.ring(alarm.id, 1)
    expect(alarm.enabled).toBe(false)
    expect(h.alarms.ringing).toEqual([alarm.id])
    const pending = h.writes.length
    h.alarms.ring(alarm.id, 2)
    expect(h.sounds[0].stop).toHaveBeenCalledOnce()
    expect(h.writes).toHaveLength(pending)
    h.alarms.dismiss(alarm.id)
    expect(h.sounds[1].stop).toHaveBeenCalledOnce()
    h.alarms.ring(alarm.id, 3)
    expect(h.sound).toHaveBeenCalledTimes(2)
    expect(h.alarms.items).toHaveLength(1)
    expect(h.alarms.ringing).toEqual([])
    await h.flush()
    expect((await readClockFile<Array<Record<string, unknown>>>(h.mock.api, 'alarms.jsonl'))?.find(row => row.id === alarm.id) ?? null).toMatchObject({ enabled: false })
  })

  it('persists a one-shot snooze across restart without resurrecting expired snoozes', async () => {
    const h = harness()
    await h.mock.api.settings.set('alarmSnooze', 4)
    const alarm = h.alarms.add({ hour: 8, minute: 0 })
    h.time(new Date(2026, 0, 1, 8).getTime())
    h.alarms.ring(alarm.id, 1)
    h.alarms.snooze(alarm.id)
    const snoozedUntil = h.now() + 4 * 60_000
    expect(alarm.snoozedUntil).toBe(snoozedUntil)
    expect(h.sounds[0].stop).toHaveBeenCalledOnce()
    h.time(h.now() + 500)
    h.alarms.action(alarm.id, 'snooze')
    expect(alarm.snoozedUntil).toBe(snoozedUntil)
    await h.flush()
    const restored = harness(h.mock)
    restored.time(snoozedUntil - 1000)
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    await restored.alarms.load([alarm.id])
    expect(schedule).toHaveBeenLastCalledWith(`alarm:${alarm.id}`, [snoozedUntil], expect.objectContaining({ ring: { actions: ['stop', 'snooze'], snoozeMinutes: 4, sound: 'beep.wav' } }))
    expect(restored.alarms.items[0].enabled).toBe(false)
    restored.time(snoozedUntil)
    restored.alarms.ring(alarm.id, 1)
    expect(restored.sound).toHaveBeenCalledOnce()
    await restored.flush()
    const expired = harness(h.mock)
    expired.time(snoozedUntil + 1)
    schedule.mockClear()
    await expired.alarms.load([alarm.id])
    expect(schedule).not.toHaveBeenCalled()
    expect(expired.alarms.items[0].snoozedUntil).toBeUndefined()
  })

  it('re-arms recurring alarms after a host Stop and keeps snooze/edit deadlines separate', async () => {
    const h = harness()
    const alarm = h.alarms.add({ hour: 8, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] })
    h.time(new Date(2026, 0, 1, 8).getTime())
    h.alarms.ring(alarm.id, 1)
    h.alarms.action(alarm.id, 'snooze')
    h.time(alarm.snoozedUntil!)
    h.alarms.ring(alarm.id, 1)
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    h.alarms.action(alarm.id, 'stop')
    expect(h.sounds.at(-1)!.stop).toHaveBeenCalledOnce()
    expect(schedule.mock.calls.at(-1)![1]).toHaveLength(8)
    expect(schedule.mock.calls.at(-1)![1][0]).toBe(new Date(2026, 0, 2, 8).getTime())
    const count = h.sound.mock.calls.length
    h.alarms.ring(alarm.id, 2)
    expect(h.sound).toHaveBeenCalledTimes(count)
    h.alarms.snooze(alarm.id)
    const edited = h.alarms.update(alarm.id, { hour: 10 })!
    expect(edited.snoozedUntil).toBeUndefined()
    h.alarms.ring(alarm.id, 1)
    expect(h.sound).toHaveBeenCalledTimes(count)
    await h.flush()
  })

  it.each(['toggle', 'update', 'remove'])('%s stops only the owning alarm tone and rejects stale repeats', async operation => {
    const h = harness()
    const first = h.alarms.add({ hour: 8, days: [4] })
    const second = h.alarms.add({ hour: 8, days: [4] })
    h.time(new Date(2026, 0, 1, 8).getTime())
    h.alarms.ring(first.id, 1); h.alarms.ring(second.id, 1)
    if (operation === 'toggle') h.alarms.toggle(first.id, false)
    else if (operation === 'update') h.alarms.update(first.id, { hour: 9 })
    else h.alarms.remove(first.id)
    expect(h.sounds[0].stop).toHaveBeenCalledOnce()
    expect(h.sounds[1].stop).not.toHaveBeenCalled()
    h.alarms.ring(first.id, 2)
    expect(h.sound).toHaveBeenCalledTimes(2)
    h.alarms.stopSounds()
    expect(h.sounds[1].stop).toHaveBeenCalledOnce()
    await h.flush()
  })

  it('captures file values, repeat days and the originating API before queued writes run', async () => {
    const h = harness()
    const other = makeMock()
    const alarm = h.alarms.add({ hour: 8, days: [1, 3], label: 'First' })
    h.alarms.update(alarm.id, { label: 'Second', days: [2] })
    const firstWrite = h.writes.shift()!
    h.api(other.api)
    h.alarms.update(alarm.id, { label: 'Third', days: [4] })
    await firstWrite()
    expect((await readClockFile<Array<Record<string, unknown>>>(h.mock.api, 'alarms.jsonl'))?.find(row => row.id === alarm.id) ?? null).toMatchObject({ label: 'First' })
    expect((await readClockFile<Array<{ days: number[] }>>(h.mock.api, 'alarms.jsonl'))![0].days).toEqual([1, 3])
    await h.flush()
    expect((await readClockFile<Array<Record<string, unknown>>>(h.mock.api, 'alarms.jsonl'))?.find(row => row.id === alarm.id) ?? null).toMatchObject({ label: 'Second' })
    expect((await readClockFile<Array<{ days: number[] }>>(h.mock.api, 'alarms.jsonl'))![0].days).toEqual([2])
    expect((await readClockFile<Array<Record<string, unknown>>>(other.api, 'alarms.jsonl'))?.find(row => row.id === alarm.id) ?? null).toMatchObject({ label: 'Third' })
    expect((await readClockFile<Array<{ days: number[] }>>(other.api, 'alarms.jsonl'))![0].days).toEqual([4])
  })

  it('restores all alarm records and repeat days in saved order', async () => {
    const h = harness()
    const records = Array.from({ length: 1001 }, (_, index) => ({ id: `saved-${index}`, hour: 8, minute: 0, label: '', enabled: false, sound: 'beep', days: [1] }))
    await writeClockFile(h.mock.api, 'alarms.jsonl', records)
    await h.alarms.load(['saved-1000', 'missing', 'saved-1000'])
    expect(h.alarms.items).toHaveLength(1001)
    expect(h.alarms.items[0]).toMatchObject({ id: 'saved-1000', days: [1], enabled: false })
    expect(h.alarms.items.every(alarm => alarm.days.length === 1)).toBe(true)
    expect(h.writes).toHaveLength(0)
  })

  it('does not apply a delayed load after the owning API changes', async () => {
    const h = harness()
    await writeClockFile(h.mock.api, 'alarms.jsonl', [{ id: 'old', hour: 8, minute: 0, label: '', sound: 'beep', enabled: true, date: null, snoozedUntil: null }])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = h.mock.api.data.files.readText
    vi.spyOn(h.mock.api.data.files, 'readText').mockImplementation(async path => {
      if (path !== 'alarms.jsonl') return read(path)
      await gate; return read(path)
    })
    const other = makeMock()
    const schedule = vi.spyOn(other.api.notifications, 'schedule')
    const loading = h.alarms.load([])
    h.api(other.api)
    release()
    await loading
    expect(h.alarms.items).toEqual([])
    expect(schedule).not.toHaveBeenCalled()
  })

  it('discards hydration after teardown and can resume it without reviving the old request', async () => {
    const h = harness()
    await writeClockFile(h.mock.api, 'alarms.jsonl', [{ id: 'saved', hour: 8, minute: 0, label: '', sound: 'beep', enabled: true, date: null, snoozedUntil: null }])
    const releases: Array<() => void> = []
    const read = h.mock.api.data.files.readText
    vi.spyOn(h.mock.api.data.files, 'readText').mockImplementation(async path => {
      if (path !== 'alarms.jsonl') return read(path)
      const attempt = releases.length
        await new Promise<void>(resolve => releases.push(resolve))
        if (attempt === 0) throw new Error('Retired read failed')
        return read(path)
    })
    const schedule = vi.spyOn(h.mock.api.notifications, 'schedule')
    const first = h.alarms.load(['saved'])
    h.alarms.suspend()
    const second = h.alarms.resumeLoading()
    expect(releases).toHaveLength(2)
    releases[0]()
    await first
    expect(h.alarms.items).toEqual([])
    expect(schedule).not.toHaveBeenCalled()
    releases[1]()
    await second
    expect(h.alarms.items[0].id).toBe('saved')
    expect(schedule).toHaveBeenCalledOnce()
    h.alarms.suspend()
    await h.alarms.resumeLoading()
    expect(releases).toHaveLength(2)
  })
})

it('leaves previews unavailable without the host playback service', () => {
  const AudioContext = vi.fn()
  vi.stubGlobal('AudioContext', AudioContext)
  expect(createSoundPlayer().play('beep')).toBeNull()
  expect(AudioContext).not.toHaveBeenCalled()
})

it('closes preview playback on unload and leaves notification audio to the host', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 1, 7))
  const mock = makeMock()
  const preview = mockPreviewPlayback(mock.api)
  const dispose = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
  try {
    await store.ready
    store.playSound('bell')!.pause()
    await vi.advanceTimersByTimeAsync(0)
    expect(preview.players).toHaveLength(1)
    expect(preview.players[0].play).not.toHaveBeenCalled()
    const alarm = store.addAlarm({ hour: 8, minute: 0 })
    vi.setSystemTime(new Date(2026, 0, 1, 8))
    const ring = { key: `alarm:${alarm.id}`, eventId: 'alarm', title: 'Alarm', tick: 1 }
    mock.emitNotificationRing(ring)
    mock.emitNotificationAction({ ...ring, action: 'stop' })
    expect(preview.players[0].dispose).not.toHaveBeenCalled()
    const timer = store.addTimer(1)!
    vi.setSystemTime(timer.endsAt)
    mock.emitNotificationRing({ ...ring, key: `timer:${timer.id}`, eventId: 'timer' })
    const cancel = vi.spyOn(mock.api.notifications, 'cancel')
    dispose()
    expect(preview.players[0].dispose).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    mock.emitNotificationRing({ ...ring, tick: 2 })
    expect(preview.players).toHaveLength(1)
    await store.flush()
  } finally { dispose() }
})
