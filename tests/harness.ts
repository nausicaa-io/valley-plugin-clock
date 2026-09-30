import { vi } from 'vitest'
import { createMockValleyApi as createBaseMock } from '@valley/plugin-testkit'
import type { PluginBackendApi, ValleyPluginApi } from '@valley/plugin-sdk'
import { createClockOwner } from '../src/backend/clockOwner'
export * from '@valley/plugin-testkit'

export function mockPreviewPlayback(api: ValleyPluginApi) {
  let nextSession = 0
  const previousCall = api.backend.call.bind(api.backend)
  api.backend.call = vi.fn(async (method: string, payload?: unknown) => method === 'sounds.list' ? [] : previousCall(method, payload)) as typeof api.backend.call
  const players: Array<ReturnType<typeof create>> = []
  function create() {
    const listeners = new Set<(snapshot: { state: { status: string } }) => void>()
    const player = { sessionId: `preview-${nextSession++}`, load: vi.fn(async () => null),
      play: vi.fn(async () => ({ status: 'observed' })), pause: vi.fn(async () => ({ status: 'observed' })), dispose: vi.fn(async () => {}),
      onChange: (listener: (snapshot: { state: { status: string } }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      emit: (status: string) => { for (const listener of listeners) listener({ state: { status } }) }
    }
    return player
  }
  const createLocalPlayer = vi.fn(async () => { const player = create(); players.push(player); return player })
  Object.assign(api.playback, { createLocalPlayer })
  return { players, createLocalPlayer }
}

type Occurrence = Parameters<Parameters<PluginBackendApi['notifications']['onOccurrence']>[0]>[0]
export function createMockValleyApi(options: Parameters<typeof createBaseMock>[0] = {}) {
  const mock = createBaseMock(options)
  const events = new Map<string, Set<(payload: unknown) => void>>()
  const occurrences = new Set<(event: Occurrence) => void>()
  const backend = {
    pluginId: 'clock', data: mock.api.data, settings: mock.api.settings,
    notifications: { ...mock.api.notifications, schedule: (...args: Parameters<PluginBackendApi['notifications']['schedule']>) => mock.api.notifications.schedule(...args), onOccurrence: (listener: (event: Occurrence) => void) => { occurrences.add(listener); return () => { occurrences.delete(listener) } } },
    services: { emit: vi.fn(async () => {}), captureCausation: vi.fn(async () => undefined) },
    i18n: { t: mock.api.ui.t },
    rpc: { emit: (event: string, payload: unknown) => { events.get(event)?.forEach(listener => listener(payload)) } }
  } as unknown as PluginBackendApi
  let owner: ReturnType<typeof createClockOwner> | undefined
  const getOwner = () => owner ??= createClockOwner(backend)
  const previous = mock.api.backend.call
  mock.api.backend.call = vi.fn(async <T>(method: string, payload?: unknown): Promise<T> => {
    if (method === 'clock.snapshot') return await getOwner().snapshot() as T
    if (method === 'clock.mutate') return await getOwner().mutate(payload as Parameters<ReturnType<typeof createClockOwner>['mutate']>[0]) as T
    return previous<T>(method, payload)
  }) as typeof mock.api.backend.call
  mock.api.backend.on = (event, listener) => {
    const listeners = events.get(event) ?? new Set()
    listeners.add(listener)
    events.set(event, listeners)
    return () => { listeners.delete(listener) }
  }
  const emitOccurrence = (event: Occurrence) => occurrences.forEach(listener => listener(event))
  const emitRing = mock.emitNotificationRing
  mock.emitNotificationRing = event => {
    if (event.tick === 1 && owner) {
      const scheduledAt = mock.scheduledNotifications.get(event.key)?.occurrences[0] ?? Date.now()
      emitOccurrence({ key: event.key, eventId: event.eventId, scheduledAt, firedAt: Date.now(), occurrenceId: `${event.key}:${scheduledAt}`, missed: false })
    }
    emitRing(event)
  }
  return { ...mock, backendApi: backend, clockOwner: getOwner, emitOccurrence, flushClock: async () => { await getOwner().snapshot() } }
}
