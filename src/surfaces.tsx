import { provideBookmarkSurface, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { ClockStore } from './store'
import type { Mode } from './preferences'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "mode": {
      "type": "union",
      "anyOf": [
        {
          "type": "literal",
          "value": "clock"
        },
        {
          "type": "literal",
          "value": "alarm"
        },
        {
          "type": "literal",
          "value": "stopwatch"
        },
        {
          "type": "literal",
          "value": "timer"
        },
        {
          "type": "literal",
          "value": "pomodoro"
        }
      ]
    },
    "alarmId": {
      "type": "string"
    },
    "timerId": {
      "type": "string"
    },
    "city": {
      "type": "string"
    }
  },
  "required": [
    "mode"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



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
  const surface = 'right_sidebar'
  const off = provideBookmarkSurface(api, {
    id: `clock.${surface}`, surface, getSnapshot: snapshot, subscribe: store.subscribe,
    restore: async (raw) => {
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
    }
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { type: 'union', anyOf: ['timerId', 'alarmId'].map(key => ({ ...bookmarkStateSchema, required: ['mode', key] })) }, description: snapshot => modeLabel(snapshot.view.mode as Mode) })
  return off
}
