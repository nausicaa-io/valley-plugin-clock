import { PLUGIN_SURFACE_V1, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { ClockStore, Mode } from './index'
import { uiText } from './localization'

const modes: Mode[] = ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro']
const modeKeys = ['auto.04f6b3ea183e', 'auto.25f8c55de811', 'auto.15bd6cc6511c', 'auto.9d9cec22f36f', 'auto.212e4618d030']
export function registerClockSurfaces(api: ValleyPluginApi, store: ClockStore): () => void {
  const modeLabel = (mode: Mode): string => uiText(modeKeys[modes.indexOf(mode)])
  const snapshot = () => {
    const { mode, alarmEditing, selectedTimer } = store.state
    const alarm = mode === 'alarm' ? store.state.alarms.find((entry) => entry.id === alarmEditing) : undefined
    const timer = mode === 'timer' ? store.state.timers.find((entry) => entry.id === selectedTimer) : undefined
    const item = alarm ? { id: alarm.id, title: alarm.label || `${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}`, state: { mode, alarmId: alarm.id } }
      : timer ? { id: timer.id, title: timer.label || modeLabel('timer'), state: { mode, timerId: timer.id } }
        : undefined
    return { title: modeLabel(mode), view: { mode }, ...(item ? { item } : {}) }
  }
  const surfaces = ['right_sidebar', 'footer'] as const
  const offs = surfaces.map((surface) => api.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: `clock.${surface}`, surface, getSnapshot: snapshot, subscribe: store.subscribe,
    restore: async (raw, _instance, options) => {
      await store.ready
      const mode = raw.mode ?? 'clock'
      if (!modes.includes(mode as Mode)) throw new Error(uiText('surface.invalid'))
      if (raw.alarmId !== undefined && !store.state.alarms.some((entry) => entry.id === raw.alarmId)) throw new Error(uiText('surface.unavailable'))
      if (raw.timerId !== undefined && !store.state.timers.some((entry) => entry.id === raw.timerId)) throw new Error(uiText('surface.unavailable'))
      if (raw.city !== undefined && !store.state.worldCities.includes(String(raw.city))) throw new Error(uiText('surface.unavailable'))
      store.state.alarmEditing = typeof raw.alarmId === 'string' ? raw.alarmId : null
      store.state.selectedTimer = typeof raw.timerId === 'string' ? raw.timerId : null
      store.state.selectedCity = typeof raw.city === 'string' ? raw.city : null
      store.setMode(mode as Mode)
      if (surface === 'footer' && !options?.background) api.workspace.revealOwnPanel('right_sidebar')
    }
  }))
  return () => offs.forEach((off) => off())
}
