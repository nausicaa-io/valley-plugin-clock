import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendOperationContext, WorkflowExecutionResult } from '@valley/plugin-sdk'
import { createMockValleyApi } from './harness'
import { registerClockWorkflow } from '../src/backend/workflow'
import type { ClockSnapshot } from '../src/backend/clockOwner'

afterEach(() => { vi.restoreAllMocks() })

function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const handlers = new Map<string, (input: unknown, context?: PluginBackendOperationContext) => unknown>()
  const api = mock.backendApi
  api.rpc.handle = (method, handler) => { handlers.set(method, handler); return () => { handlers.delete(method) } }
  api.rpc.handleOperation = (method, handler) => { handlers.set(method, handler as never); return () => { handlers.delete(method) } }
  const captureCausation = vi.fn(async () => 'workflow-origin')
  const context = { id: 'clock-action', api: { ...api, services: { ...api.services, captureCausation } } } as unknown as PluginBackendOperationContext
  const off = registerClockWorkflow(api)
  const execute = (nodeTypeId: string, parameters: Record<string, unknown> = {}) => handlers.get('workflow.execute')!({ nodeTypeId, parameters, items: [{ json: {} }] }, context) as Promise<WorkflowExecutionResult>
  const snapshot = () => handlers.get('clock.snapshot')!(undefined) as Promise<ClockSnapshot>
  return { mock, handlers, off, execute, snapshot, captureCausation }
}

describe('Clock workflow contribution', () => {
  it('runs timer and alarm actions through the shared owner with captured causation', async () => {
    const h = setup()
    const timer = (await h.execute('timer.start', { seconds: 60, name: 'Check samples' })).items[0].json
    expect(timer).toMatchObject({ label: 'Check samples', running: true, originReceipt: 'workflow-origin' })
    await h.execute('timer.pause', { id: timer.id })
    expect((await h.snapshot()).timers[0].running).toBe(false)
    await h.execute('timer.resume', { id: timer.id })
    expect((await h.snapshot()).timers[0].running).toBe(true)
    await h.execute('timer.cancel', { id: timer.id })
    expect((await h.snapshot()).timers).toEqual([])
    const alarm = (await h.execute('alarm.create', { hour: 9, minute: 30, name: 'Start', days: [1, 2, 3, 4, 5] })).items[0].json
    expect(alarm).toMatchObject({ enabled: true, originReceipt: 'workflow-origin' })
    expect((await h.execute('alarm.disable', { id: alarm.id })).items[0].json.enabled).toBe(false)
    expect((await h.execute('alarm.enable', { id: alarm.id })).items[0].json.enabled).toBe(true)
    expect(h.captureCausation).toHaveBeenCalledTimes(7)
    await h.off()
    expect(h.handlers.size).toBe(0)
  })

  it('rejects invalid values and missing records before returning success', async () => {
    const h = setup()
    await expect(h.execute('timer.start', { seconds: 0 })).rejects.toThrow('duration')
    await expect(h.execute('alarm.create', { hour: 8, minute: 0, date: '2026-02-30' })).rejects.toThrow('date')
    await expect(h.execute('timer.cancel', { id: 'missing' })).rejects.toThrow('cannot perform')
    await expect(h.execute('alarm.disable', { id: 'missing' })).rejects.toThrow('cannot perform')
    expect(await h.snapshot()).toMatchObject({ timers: [], alarms: [] })
    await h.off()
  })
})
