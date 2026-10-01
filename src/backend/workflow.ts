import { registerWorkflowContribution, type PluginBackendApi, type WorkflowContributionContract } from '@valley/plugin-sdk'
import { createClockOwner, type ClockMutation } from './clockOwner'
import type { ClockAlarm } from '../alarms'
import config from '../../config.json'

export function registerClockWorkflow(api: PluginBackendApi): () => Promise<void> {
  const owner = createClockOwner(api)
  const offs = [
    api.rpc.handle('clock.snapshot', () => owner.snapshot()),
    api.rpc.handleOperation('command.clock.snapshot', (_input, context) => { context.cancellation.throwIfAborted(); return owner.snapshot() }),
    api.rpc.handleOperation('command.stopwatch.get', async (_input, context) => { context.cancellation.throwIfAborted(); const snapshot = await owner.snapshot(); const state = snapshot.stopwatch.state; return { session: snapshot.session, revision: snapshot.stopwatch.revision, state, elapsedMs: state.elapsed + (state.running ? Math.max(0, Date.now() - state.startedAt) : 0) } }),
    api.rpc.handleOperation('command.clock.mutate', async (raw, context) => {
      context.cancellation.throwIfAborted()
      const { method, values } = raw as { method: string; values: Record<string, unknown> }
      const parameters = values ?? {}
      const args = method.endsWith('.move') ? [undefined, parameters.from, parameters.to]
        : method === 'pomo.add' ? [undefined, parameters.name]
        : method === 'pomo.rename' ? [parameters.id, parameters.name, parameters.override]
        : method.endsWith('.update') ? [parameters.id, parameters.patch]
        : [parameters.id]
      const result = await owner.mutate({ method, args, ...(method.startsWith('stopwatch.') ? { expectedSession: parameters.expectedSession as string, expectedRevision: parameters.expectedRevision as number } : {}) }, await context.api.services.captureCausation(), context.api, context.cancellation)
      if (result.value === false || result.value === null) throw Object.assign(new Error('This Clock item cannot perform the requested action.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
      return result
    }),
    api.rpc.handle('clock.mutate', payload => owner.mutate(payload as ClockMutation))
  ]
  const contribution = registerWorkflowContribution(api, config.runtime.services[0].metadata.workflow as unknown as WorkflowContributionContract, async ({ nodeTypeId, parameters }, context) => {
    const origin = await context.api.services.captureCausation()
    let request: ClockMutation
    if (nodeTypeId === 'timer.start') request = { method: 'timer.add', args: [undefined, parameters.seconds, parameters.name] }
    else if (nodeTypeId === 'timer.pause' || nodeTypeId === 'timer.resume' || nodeTypeId === 'timer.cancel') {
      if (typeof parameters.id !== 'string' || !parameters.id.trim()) throw new Error('Expected a timer id.')
      request = { method: nodeTypeId, args: [parameters.id] }
    } else if (nodeTypeId === 'alarm.create') {
      if (typeof parameters.hour !== 'number' || typeof parameters.minute !== 'number') throw new Error('Expected an alarm hour and minute.')
      const days = parameters.days === undefined ? [] : parameters.days
      if (!Array.isArray(days) || !days.every(value => typeof value === 'number')) throw new Error('Expected a weekday list.')
      request = { method: 'alarm.add', args: [undefined, { hour: parameters.hour, minute: parameters.minute, label: parameters.name ?? '', days, date: parameters.date, enabled: true } as Partial<ClockAlarm>] }
    } else if (nodeTypeId === 'alarm.enable' || nodeTypeId === 'alarm.disable') {
      if (typeof parameters.id !== 'string' || !parameters.id.trim()) throw new Error('Expected an alarm id.')
      request = { method: 'alarm.toggle', args: [parameters.id, nodeTypeId === 'alarm.enable'] }
    } else throw new Error('Unknown Clock workflow action.')
    const result = await owner.mutate(request, origin, context.api)
    if (result.value === false || result.value === null) throw new Error('This Clock item cannot perform the requested action.')
    const record = result.value && typeof result.value === 'object' ? result.value : { id: parameters.id, changed: result.value }
    return { items: [{ json: JSON.parse(JSON.stringify(record)) as Record<string, unknown> }] }
  })
  return async () => { contribution.dispose(); offs.forEach(off => off()); await owner.dispose() }
}
