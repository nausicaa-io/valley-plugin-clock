import type { PluginBackendApi } from '@valley/plugin-sdk'
import { registerWorkflowContribution, type WorkflowContributionContract } from '@valley/plugin-sdk/workflow'
import { createClockOwner, type ClockMutation } from './clockOwner'
import type { ClockAlarm } from '../alarms'
import config from '../../config.json'

export function registerClockWorkflow(api: PluginBackendApi): () => Promise<void> {
  const commands = new Map<string, Parameters<PluginBackendApi['rpc']['handleOperation']>[1]>()
  const operation: PluginBackendApi['rpc']['handleOperation'] = (method, handler) => { commands.set(method, handler); return api.rpc.handleOperation(method, handler) }
  const owner = createClockOwner(api)
  const offs = [
    api.rpc.handle('clock.snapshot', () => owner.snapshot()),
    operation('command.clock.snapshot', (_input, context) => { context.cancellation.throwIfAborted(); return owner.snapshot() }),
    operation('command.stopwatch.get', async (_input, context) => { context.cancellation.throwIfAborted(); const snapshot = await owner.snapshot(); const state = snapshot.stopwatch.state; return { session: snapshot.session, revision: snapshot.stopwatch.revision, state, elapsedMs: state.elapsed + (state.running ? Math.max(0, Date.now() - state.startedAt) : 0) } }),
    operation('command.clock.mutate', async (raw, context) => {
      context.cancellation.throwIfAborted()
      const { method, values } = raw as { method: string; values: Record<string, unknown> }
      const parameters = values ?? {}
      const args = method.endsWith('.move') ? [undefined, parameters.from, parameters.to]
        : method === 'pomo.add' ? [undefined, parameters.name]
        : method === 'pomo.rename' ? [parameters.id, parameters.name, parameters.override]
        : method.endsWith('.update') ? [parameters.id, parameters.patch]
        : [parameters.id]
      const result = await owner.mutate({ method, args, ...(method.startsWith('stopwatch.') ? { expectedSession: parameters.expectedSession as string, expectedRevision: parameters.expectedRevision as number } : {}) }, await context.api.services.captureCausation(), context.api, context.cancellation)
      if (result.value === false || result.value === null) throw Object.assign(new Error('This Clock item cannot perform the requested action.'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
      return result
    }),
    api.rpc.handle('clock.mutate', payload => owner.mutate(payload as ClockMutation))
  ]
  const contribution = registerWorkflowContribution(api, (config.runtime.services[0] as unknown as { metadata: { workflow: WorkflowContributionContract } }).metadata.workflow, async ({ nodeTypeId, parameters }, context) => {
    context.cancellation.throwIfAborted()
    const bindings: Record<string, { method: string; request: { constants?: Record<string, unknown>; inputProperty?: string } }> = {
  "snapshot": {
    "method": "command.clock.snapshot",
    "request": {}
  },
  "timer.stop": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "timer.stop"
      },
      "inputProperty": "values"
    }
  },
  "alarm.remove": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "alarm.remove"
      },
      "inputProperty": "values"
    }
  },
  "alarm.dismiss": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "alarm.dismiss"
      },
      "inputProperty": "values"
    }
  },
  "alarm.snooze": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "alarm.snooze"
      },
      "inputProperty": "values"
    }
  },
  "pomo.select": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.select"
      },
      "inputProperty": "values"
    }
  },
  "pomo.remove": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.remove"
      },
      "inputProperty": "values"
    }
  },
  "timer.move": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "timer.move"
      },
      "inputProperty": "values"
    }
  },
  "alarm.move": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "alarm.move"
      },
      "inputProperty": "values"
    }
  },
  "pomo.move": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.move"
      },
      "inputProperty": "values"
    }
  },
  "pomo.start": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.start"
      },
      "inputProperty": "values"
    }
  },
  "pomo.pause": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.pause"
      },
      "inputProperty": "values"
    }
  },
  "pomo.reset": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.reset"
      },
      "inputProperty": "values"
    }
  },
  "pomo.skip": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.skip"
      },
      "inputProperty": "values"
    }
  },
  "pomo.add": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.add"
      },
      "inputProperty": "values"
    }
  },
  "pomo.rename": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.rename"
      },
      "inputProperty": "values"
    }
  },
  "timer.update": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "timer.update"
      },
      "inputProperty": "values"
    }
  },
  "alarm.update": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "alarm.update"
      },
      "inputProperty": "values"
    }
  },
  "pomo.update": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "pomo.update"
      },
      "inputProperty": "values"
    }
  },
  "stopwatch.get": {
    "method": "command.stopwatch.get",
    "request": {}
  },
  "stopwatch.start": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "stopwatch.start"
      },
      "inputProperty": "values"
    }
  },
  "stopwatch.stop": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "stopwatch.stop"
      },
      "inputProperty": "values"
    }
  },
  "stopwatch.lap": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "stopwatch.lap"
      },
      "inputProperty": "values"
    }
  },
  "stopwatch.reset": {
    "method": "command.clock.mutate",
    "request": {
      "constants": {
        "method": "stopwatch.reset"
      },
      "inputProperty": "values"
    }
  }
}
    const binding = bindings[nodeTypeId]
    if (binding) {
      const input = binding.request.inputProperty ? { ...binding.request.constants, [binding.request.inputProperty]: parameters } : { ...parameters, ...binding.request.constants }
      const result = await commands.get(binding.method)!(input, context)
      return { items: [{ json: JSON.parse(JSON.stringify(result)) as Record<string, unknown> }] }
    }
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
    const result = await owner.mutate(request, origin, context.api, context.cancellation)
    if (result.value === false || result.value === null) throw new Error('This Clock item cannot perform the requested action.')
    const record = result.value && typeof result.value === 'object' ? result.value : { id: parameters.id, changed: result.value }
    return { items: [{ json: JSON.parse(JSON.stringify(record)) as Record<string, unknown> }] }
  })
  void contribution.ready.catch(error => api.rpc.emit('workflow.registrationFailed', { message: error instanceof Error ? error.message : String(error) }))
  return async () => { contribution.dispose(); offs.forEach(off => off()); await owner.dispose() }
}
