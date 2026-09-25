import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { initLocalization } from './localization'
import { injectStyles } from './styles'
import { getStore } from './store'
import { createClockViews } from './views'
import { registerCommands } from './commands'
import { registerClockSurfaces } from './surfaces'

export type { ClockStore } from './store'
export { VIEW_SETTING, CLOCK_VIEWS, viewEnabled, visibleModes, orderedModes, readStringList, TIMER_PRESET_LIMIT, DEFAULT_TIMER_PRESETS, timerPresets, fmtPresetLabel } from './preferences'
export type { Mode, ClockView } from './preferences'
export { reorder } from './reorder'
export { nextAlarmAt, nextOccurrences, WEEK_START_INDEX, orderedWeekdays, repeatLabel, parseClockTime, parseDays } from './alarms'
export type { ClockAlarm } from './alarms'
export { SOUNDS, SOUND_IDS } from './sounds'
export type { AlarmSoundId } from './sounds'
export { CITIES, cityTime, cityHour, isDaytime, dayOffsetLabel } from './worldClock'
export type { City } from './worldClock'
export { fmtStopwatch } from './stopwatch'
export { fmtCountdown, parseDuration } from './timers'
export type { ClockTimer } from './timers'
export { pomodoroNextPhase, pomoPhaseName } from './pomodoro'
export type { PomodoroProfile } from './pomodoro'
export { clockNeedsAnimation } from './views'
export type { AnimState } from './views'

export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  const disposeStyles = injectStyles()
  const store = getStore(api)
  const { Panel, SettingsView } = createClockViews(api, store)
  api.registerView('clock.panel', Panel)
  api.registerView('clock.settings', SettingsView)
  const offs = registerCommands(api, store)
  const offSurfaces = registerClockSurfaces(api, store)

  const onSettings = (): void => store.syncSettings()
  const offSettings = api.settings.subscribe(onSettings)
  const offNotifications = store.listen(api)
  const offFlush = api.runtime.onBeforeUnload(() => store.flush())

  return () => {
    offs.forEach((off) => off())
    offSurfaces()
    offSettings()
    // Without this the previous session keeps answering ring ticks after a hot
    // reload, and every alarm sounds once per surviving listener.
    offNotifications()
    offFlush()
    disposeStyles()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
