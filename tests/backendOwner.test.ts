import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './harness'
import { createClockOwner } from '../src/backend/clockOwner'
import { readClockFile } from '../src/persistence'
import { register, type ClockStore } from '../src/index'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('background Clock owner', () => {
  it('finishes timers without a renderer and emits once with persisted causation across reload', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.ready
    const result = await owner.mutate({ method: 'timer.add', args: ['headless', 5, 'Focus'] }, 'origin-receipt')
    expect(result.snapshot.timers).toHaveLength(1)
    vi.setSystemTime(1_005_000)
    const event = { key: 'timer:headless', eventId: 'clock.timer', occurrenceId: 'clock:timer:headless:1005000', scheduledAt: 1_005_000, firedAt: 1_005_000, missed: false }
    h.emitOccurrence(event)
    await owner.snapshot()
    expect(h.backendApi.services.emit).toHaveBeenCalledWith('workflow.provider', 'timer.finished', expect.objectContaining({ record: expect.objectContaining({ id: 'headless', running: false }), occurrenceId: event.occurrenceId }), { causation: 'origin-receipt' })
    h.emitOccurrence(event)
    await owner.snapshot()
    expect(h.backendApi.services.emit).toHaveBeenCalledOnce()
    expect(await readClockFile(h.api, 'timers.jsonl')).toEqual([expect.objectContaining({ id: 'headless', originReceipt: 'origin-receipt', remaining: 0 })])
    await owner.dispose()
    const reloaded = createClockOwner(h.backendApi)
    await reloaded.ready
    h.emitOccurrence(event)
    await reloaded.snapshot()
    expect(h.backendApi.services.emit).toHaveBeenCalledOnce()
    await reloaded.dispose()
  })

  it('keeps timer commands serialized and rejects invalid names and durations', async () => {
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'timer.add', args: ['one', 30, 'One'] })
    await Promise.all([owner.mutate({ method: 'timer.pause', args: ['one'] }), owner.mutate({ method: 'timer.resume', args: ['one'] }, 'resume-origin'), owner.mutate({ method: 'timer.add', args: ['two', 60, 'Two'] })])
    const snapshot = await owner.snapshot()
    expect(snapshot.timers).toEqual([expect.objectContaining({ id: 'one', running: true, originReceipt: 'resume-origin' }), expect.objectContaining({ id: 'two' })])
    await expect(owner.mutate({ method: 'timer.add', args: ['invalid', 3600000] })).rejects.toThrow('duration')
    await expect(owner.mutate({ method: 'timer.add', args: ['invalid', 60, 'a'.repeat(41)] })).rejects.toThrow('40 characters')
    expect((await owner.snapshot()).timers).toHaveLength(2)
    await owner.dispose()
  })

  it('preserves the original causation when a running timer rejects resume', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'timer.add', args: ['running', 1] }, 'started-by-workflow')
    expect((await owner.mutate({ method: 'timer.resume', args: ['running'] }, 'rejected-resume')).value).toBe(false)
    expect((await owner.snapshot()).timers[0].originReceipt).toBe('started-by-workflow')
    vi.setSystemTime(1_001_000)
    h.emitOccurrence({ key: 'timer:running', eventId: 'clock.timer', occurrenceId: 'running:1001000', scheduledAt: 1_001_000, firedAt: 1_001_000, missed: false })
    await owner.snapshot()
    expect(h.backendApi.services.emit).toHaveBeenCalledWith('workflow.provider', 'timer.finished', expect.objectContaining({ record: expect.objectContaining({ id: 'running' }) }), { causation: 'started-by-workflow' })
    expect(await readClockFile(h.api, 'timers.jsonl')).toEqual([expect.objectContaining({ originReceipt: 'started-by-workflow' })])
    await owner.dispose()
  })

  it('ignores canceled and missed workflow occurrences while retaining normal Clock state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'timer.add', args: ['cancel', 1] })
    await owner.mutate({ method: 'timer.cancel', args: ['cancel'] })
    await owner.mutate({ method: 'timer.add', args: ['missed', 1] })
    vi.setSystemTime(1_001_000)
    h.emitOccurrence({ key: 'timer:cancel', eventId: 'clock.timer', occurrenceId: 'canceled', scheduledAt: 1_001_000, firedAt: 1_001_000, missed: false })
    h.emitOccurrence({ key: 'timer:missed', eventId: 'clock.timer', occurrenceId: 'missed', scheduledAt: 1_001_000, firedAt: 1_001_000, missed: true })
    expect((await owner.snapshot()).timers).toEqual([expect.objectContaining({ id: 'missed', running: false, remaining: 0 })])
    expect(h.backendApi.services.emit).not.toHaveBeenCalled()
    await owner.dispose()
  })

  it('fires alarms once and keeps disable, enable, and snooze state in the same owner', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 7))
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'alarm.add', args: ['wake', { hour: 8, minute: 0, label: 'Start', days: [] }] }, 'alarm-origin')
    expect((await owner.mutate({ method: 'alarm.toggle', args: ['wake', false] })).value).toMatchObject({ enabled: false })
    await owner.mutate({ method: 'alarm.toggle', args: ['wake', true] })
    vi.setSystemTime(new Date(2026, 8, 30, 8))
    const at = Date.now()
    h.emitOccurrence({ key: 'alarm:wake', eventId: 'clock.alarm', occurrenceId: `wake:${at}`, scheduledAt: at, firedAt: at, missed: false })
    expect((await owner.snapshot()).alarms[0].enabled).toBe(false)
    expect(h.backendApi.services.emit).toHaveBeenCalledWith('workflow.provider', 'alarm.fired', expect.objectContaining({ record: expect.objectContaining({ id: 'wake' }) }), { causation: 'alarm-origin' })
    await owner.mutate({ method: 'alarm.snooze', args: ['wake'] })
    expect((await owner.snapshot()).alarms[0].snoozedUntil).toBeGreaterThan(at)
    await owner.dispose()
  })

  it('reflects backend edits in the existing UI store and schedules only in the backend', async () => {
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const off = register(h.api)
    const store = h.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing store') })
    await store.ready
    const timer = store.addTimer(30, 'UI timer')!
    await store.flush()
    expect(h.notificationCalls.filter(call => call.method === 'schedule' && call.key === `timer:${timer.id}`)).toHaveLength(1)
    await h.clockOwner().mutate({ method: 'timer.pause', args: [timer.id] })
    expect(store.state.timers.find(item => item.id === timer.id)?.running).toBe(false)
    off()
    await h.clockOwner().mutate({ method: 'timer.add', args: ['closed-window', 60] })
    expect((await h.clockOwner().snapshot()).timers.some(item => item.id === 'closed-window')).toBe(true)
    await h.clockOwner().dispose()
  })

  it('restores a deleted alarm identity so earlier command undo still targets the same alarm', async () => {
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const off = register(h.api)
    const store = h.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing store') })
    await store.ready
    const alarm = store.addAlarm({ hour: 8, minute: 0, label: 'Original alarm' })
    await store.flush()
    expect((await h.api.commands.execute('clock:alarm-toggle', { id: alarm.id })).ok).toBe(true)
    expect((await h.clockOwner().snapshot()).alarms[0].enabled).toBe(false)
    expect((await h.api.commands.execute('clock:alarm-remove', { id: alarm.id })).ok).toBe(true)
    expect((await h.clockOwner().snapshot()).alarms).toEqual([])
    expect(h.busUndo).toHaveLength(2)
    await h.busUndo[1].undo()
    expect((await h.clockOwner().snapshot()).alarms).toEqual([expect.objectContaining({ id: alarm.id, enabled: false, label: 'Original alarm' })])
    await h.busUndo[0].undo()
    expect((await h.clockOwner().snapshot()).alarms).toEqual([expect.objectContaining({ id: alarm.id, enabled: true })])
    off()
    await h.clockOwner().dispose()
  })

  it('replays a just-due alarm after startup and refills recurring alarms without a renderer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 7))
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'alarm.add', args: ['repeat', { hour: 8, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }] })
    await owner.dispose()
    vi.setSystemTime(new Date(2026, 8, 30, 8, 0, 1))
    const reloaded = createClockOwner(h.backendApi)
    await reloaded.ready
    const scheduledAt = new Date(2026, 8, 30, 8).getTime()
    h.emitOccurrence({ key: 'alarm:repeat', eventId: 'clock.alarm', occurrenceId: `repeat:${scheduledAt}`, scheduledAt, firedAt: scheduledAt, missed: false })
    expect((await reloaded.snapshot()).ringing).toEqual(['repeat'])
    expect(h.backendApi.services.emit).toHaveBeenCalledOnce()
    expect(h.scheduledNotifications.get('alarm:repeat')?.occurrences).toHaveLength(8)
    await reloaded.dispose()
  })

  it('reports uncertain outcomes when a committed timer cannot be scheduled', async () => {
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.ready
    vi.spyOn(h.api.notifications, 'schedule').mockResolvedValueOnce(false)
    await expect(owner.mutate({ method: 'timer.add', args: ['committed', 60] })).rejects.toMatchObject({ outcomeUnknown: true })
    expect((await owner.snapshot()).timers).toHaveLength(1)
    expect(await readClockFile(h.api, 'timers.jsonl')).toEqual([expect.objectContaining({ id: 'committed' })])
    await owner.dispose()
  })

  it('accepts the host replay of a due snooze without scheduling an expired snooze again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 7))
    const h = createMockValleyApi({ manifest: { id: 'clock' } })
    const owner = h.clockOwner()
    await owner.mutate({ method: 'alarm.add', args: ['snoozed', { hour: 8, minute: 0, enabled: false }] })
    await owner.mutate({ method: 'alarm.snooze', args: ['snoozed'] })
    const at = (await owner.snapshot()).alarms[0].snoozedUntil!
    await owner.dispose()
    vi.setSystemTime(at + 1)
    const reloaded = createClockOwner(h.backendApi)
    await reloaded.ready
    h.emitOccurrence({ key: 'alarm:snoozed', eventId: 'clock.alarm', occurrenceId: `snoozed:${at}`, scheduledAt: at, firedAt: at, missed: false })
    expect((await reloaded.snapshot()).alarms[0].snoozedUntil).toBeUndefined()
    expect(h.backendApi.services.emit).toHaveBeenCalledOnce()
    expect(h.scheduledNotifications.has('alarm:snoozed')).toBe(false)
    await reloaded.dispose()
  })
})
