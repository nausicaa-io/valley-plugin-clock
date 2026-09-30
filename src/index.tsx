import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { initLocalization } from './localization'
import { injectStyles } from './styles'
import { getStore } from './store'
import { createClockViews } from './views'
import { registerCommands } from './commands'
import { registerClockSurfaces } from './surfaces'
import { parseDuration } from './timers'
import { parseClockTime } from './alarms'
import { viewEnabled } from './preferences'

export type { ClockStore } from './store'
export { VIEW_SETTING, CLOCK_VIEWS, viewEnabled, visibleModes, orderedModes, readStringList, DEFAULT_TIMER_PRESETS, timerPresets, fmtPresetLabel } from './preferences'
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
  const offLinkHandler = api.links.register({
    id: 'prefill', label: api.ui.t('manifest.name'), version: '1.0.0', categories: ['time', 'duration'],
    open: async ({ category, value }) => {
      await store.ready
      if (!viewEnabled(category === 'duration' ? 'timer' : 'alarm', api.settings.get())) return { status: 'unavailable' }
      if (category === 'duration') {
        const seconds = parseDuration(value)
        if (seconds <= 0 || seconds > 999 * 3600 + 3599) return { status: 'unavailable' }
        store.state.pick = { h: Math.floor(seconds / 3600), m: Math.floor(seconds / 60) % 60, s: seconds % 60, label: '' }
        store.setMode('timer')
      } else {
        const time = parseClockTime(value)
        if (!time) return { status: 'failed' }
        store.state.alarmDraft = time
        store.setMode('alarm')
      }
      store.notify()
      api.workspace.revealOwnPanel('right_sidebar')
      return { status: 'opened' }
    }
  })

  const onSettings = (): void => store.syncSettings()
  const offSettings = api.settings.subscribe(onSettings)
  const offNotifications = store.listen(api)
  const offFlush = api.runtime.onBeforeUnload(() => store.flush())

  return () => {
    offLinkHandler()
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
