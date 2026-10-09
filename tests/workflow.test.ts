import Ajv from 'ajv'
import config from '../config.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendOperationContext, WorkflowExecutionResult } from '@valley/plugin-sdk'
import { createMockValleyApi } from './harness'
import { registerClockWorkflow } from '../src/backend/workflow'
import type { ClockSnapshot } from '../src/backend/clockOwner'

afterEach(() => { vi.restoreAllMocks() })

const outputSchemas = new Map(config.runtime.services.flatMap(service => service.metadata && 'commands' in service.metadata ? (service.metadata.commands ?? []).map(command => [command.id, new Ajv({ strict: false, strictSchema: true, allErrors: true, validateFormats: false, allowUnionTypes: true, ownProperties: true }).compile(command.outputSchema)] as const) : service.metadata && 'command' in service.metadata ? [[service.metadata.command.id, new Ajv({ strict: false, strictSchema: true, allErrors: true, validateFormats: false, allowUnionTypes: true, ownProperties: true }).compile(service.metadata.command.outputSchema)] as const] : []))

function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const handlers = new Map<string, (input: unknown, context?: PluginBackendOperationContext) => unknown>()
  const api = mock.backendApi
  api.rpc.handle = (method, handler) => { handlers.set(method, handler); return () => { handlers.delete(method) } }
  api.rpc.handleOperation = (method, handler) => { handlers.set(method, async (input, context) => { const result = await handler(input, context!); const value = input as { nodeTypeId?: string; method?: string }; const id = method === 'command.clock.snapshot' ? 'snapshot' : method === 'command.stopwatch.get' ? 'stopwatch.get' : value.nodeTypeId ?? value.method!; const validate = outputSchemas.get(id)!; expect(validate(result), id + ': ' + JSON.stringify(validate.errors)).toBe(true); return result }); return () => { handlers.delete(method) } }
  const captureCausation = vi.fn(async () => 'workflow-origin')
  const context = { id: 'clock-action', cancellation: new AbortController().signal, api: { ...api, services: { ...api.services, captureCausation } } } as unknown as PluginBackendOperationContext
  const schemas = new Map<string, ReturnType<Ajv['compile']>>()
  api.schema = {
    compile: async ({ schema }) => { const handle = crypto.randomUUID(); schemas.set(handle, new Ajv({ strict: false, validateFormats: false, allowUnionTypes: true }).compile(schema)); return { handle, digest: handle } },
    validate: async (request) => { const validate = schemas.get(request.handle)!; return { valid: Boolean(validate('value' in request ? request.value : undefined)), issues: [] } },
    release: async (handle) => { schemas.delete(handle) }
  }
  const off = registerClockWorkflow(api)
  const execute = async (nodeTypeId: string, parameters: Record<string, unknown> = {}) => { await vi.waitFor(() => expect(handlers.has('workflow.execute')).toBe(true)); return handlers.get('workflow.execute')!({ nodeTypeId, parameters, items: [{ json: {} }] }, context) as Promise<WorkflowExecutionResult> }
  const snapshot = () => handlers.get('clock.snapshot')!(undefined) as Promise<ClockSnapshot>
  return { mock, handlers, off, execute, snapshot, captureCausation, context }
}

describe('Clock workflow contribution', () => {

  it('checks every background command output against its declared result shape', async () => {
    const h = setup()
    const mutate = (method: string, values: Record<string, unknown> = {}) => h.handlers.get('command.clock.mutate')!({ method, values }, h.context) as Promise<{ value: { id: string } }>
    try {
      const first = (await h.execute('timer.start', { seconds: 60 })).items[0].json
      const second = (await h.execute('timer.start', { seconds: 90 })).items[0].json
      await mutate('timer.move', { from: 0, to: 1 }); await mutate('timer.stop', { id: first.id })
      await h.execute('timer.pause', { id: first.id }); await mutate('timer.update', { id: first.id, patch: { label: 'Revised', duration: 100000 } })
      await h.execute('timer.resume', { id: first.id }); await h.execute('timer.cancel', { id: second.id })
      const alarm = (await h.execute('alarm.create', { hour: 12, minute: 30 })).items[0].json
      const another = (await h.execute('alarm.create', { hour: 13, minute: 30 })).items[0].json
      await mutate('alarm.move', { from: 0, to: 1 }); await mutate('alarm.update', { id: alarm.id, patch: { label: 'Revised' } })
      await mutate('alarm.dismiss', { id: alarm.id }); await mutate('alarm.snooze', { id: alarm.id })
      await h.execute('alarm.disable', { id: alarm.id }); await h.execute('alarm.enable', { id: alarm.id }); await mutate('alarm.remove', { id: another.id })
      const profile = (await mutate('pomo.add', { name: 'Test' })).value
      await mutate('pomo.add', { name: 'Second' }); await mutate('pomo.move', { from: 1, to: 2 })
      await mutate('pomo.select', { id: profile.id }); await mutate('pomo.rename', { id: profile.id, name: 'Updated', override: true })
      await mutate('pomo.update', { id: profile.id, patch: { work: 30 } })
      for (const method of ['pomo.start', 'pomo.pause', 'pomo.skip', 'pomo.reset']) await mutate(method)
      await mutate('pomo.remove', { id: profile.id })
      await h.handlers.get('command.clock.snapshot')!({}, h.context)
      for (const [id, validate] of outputSchemas) expect(validate({}), id).toBe(false)
    } finally { await h.off() }
  })

  it('controls stopwatch state without a renderer through scoped, versioned commands', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const h = setup()
    const read = () => h.handlers.get('command.stopwatch.get')!({}, h.context) as Promise<{ session: string; revision: number; elapsedMs: number; state: { running: boolean; laps: number[] } }>
    const write = vi.fn(h.context.api.data.files.writeTextGuarded)
    const scoped = { ...h.context, api: { ...h.context.api, data: { ...h.context.api.data, files: { ...h.context.api.data.files, writeTextGuarded: write } } } }
    const control = async (method: string) => { const state = await read(); return h.handlers.get('command.clock.mutate')!({ method, values: { expectedSession: state.session, expectedRevision: state.revision } }, scoped) }
    try {
      await control('stopwatch.start')
      vi.setSystemTime(1_060_000)
      await control('stopwatch.lap')
      vi.setSystemTime(1_090_000)
      await control('stopwatch.stop')
      expect(await read()).toMatchObject({ elapsedMs: 90_000, state: { running: false, laps: [60_000] } })
      expect(write).toHaveBeenCalledWith('stopwatch.json', expect.any(String), expect.anything())
      await control('stopwatch.reset')
      expect(await read()).toMatchObject({ elapsedMs: 0, state: { running: false, laps: [] } })
    } finally { await h.off(); vi.useRealTimers() }
  })

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

  it('exposes background snapshot, timer edits and Pomodoro actions through the same scoped owner', async () => {
    const h = setup()
    const timer = (await h.execute('timer.start', { seconds: 60 })).items[0].json
    const mutate = (method: string, values: Record<string, unknown> = {}) => h.handlers.get('command.clock.mutate')!({ method, values }, h.context)
    await h.execute('timer.pause', { id: timer.id })
    await mutate('timer.update', { id: timer.id, patch: { label: 'Updated', duration: 120000 } })
    expect((await h.snapshot()).timers[0]).toMatchObject({ label: 'Updated', duration: 120000 })
    await mutate('pomo.start')
    const state = await h.handlers.get('command.clock.snapshot')!({}, h.context) as ClockSnapshot
    expect(state.pomo.state.running).toBe(true)
    await mutate('pomo.pause')
    expect((await h.snapshot()).pomo.state.running).toBe(false)
    await h.off()
  })

  it('rejects invalid values and missing records before returning success', async () => {
    const h = setup()
    await expect(h.execute('timer.start', { seconds: 0 })).rejects.toThrow('schema')
    await expect(h.execute('alarm.create', { hour: 8, minute: 0, date: '2026-02-30' })).rejects.toThrow('date')
    await expect(h.execute('timer.cancel', { id: 'missing' })).rejects.toThrow('cannot perform')
    await expect(h.execute('alarm.disable', { id: 'missing' })).rejects.toThrow('cannot perform')
    expect(await h.snapshot()).toMatchObject({ timers: [], alarms: [] })
    await h.off()
  })

  it('refuses to stop, dismiss or snooze unknown or silent items before changing Clock state', async () => {
    const h = setup()
    const stopRing = vi.spyOn(h.mock.backendApi.notifications, 'stopRing').mockResolvedValue(false)
    const snooze = vi.spyOn(h.mock.backendApi.notifications, 'snooze').mockResolvedValue(false)
    const mutate = (method: string, id: unknown) => h.handlers.get('command.clock.mutate')!({ method, values: { id } }, h.context) as Promise<{ value: unknown }>
    try {
      const timer = (await h.execute('timer.start', { seconds: 60 })).items[0].json
      const alarm = (await h.execute('alarm.create', { hour: 8, minute: 0 })).items[0].json
      const before = await h.snapshot(), saved = await h.mock.api.data.files.readText('alarms.jsonl')
      for (const [method, id] of [['timer.stop', timer.id], ['timer.stop', 'missing'], ['alarm.dismiss', alarm.id], ['alarm.dismiss', 'missing'], ['alarm.snooze', alarm.id], ['alarm.snooze', 'missing']] as const) {
        await expect(mutate(method, id), `${method} ${id}`).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
      }
      const after = await h.snapshot()
      expect([after.timers, after.alarms, after.ringing]).toEqual([before.timers, before.alarms, before.ringing])
      expect(await h.mock.api.data.files.readText('alarms.jsonl')).toBe(saved)
      expect(stopRing.mock.calls).toEqual([[`timer:${timer.id}`], [`alarm:${alarm.id}`]])
      expect(snooze.mock.calls).toEqual([[`alarm:${alarm.id}`, 9]])
      stopRing.mockResolvedValue(true); snooze.mockResolvedValue(true)
      expect((await mutate('timer.stop', timer.id)).value).toBe(true)
      expect((await mutate('alarm.snooze', alarm.id)).value).toBe(true)
      expect((await h.snapshot()).alarms[0].snoozedUntil).toBeGreaterThan(Date.now())
    } finally { await h.off() }
  })
})
