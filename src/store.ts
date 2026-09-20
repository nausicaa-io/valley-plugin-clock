import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import { createTimers, fmtCountdown, type ClockTimer } from './timers'
import { createStopwatch, type SwState } from './stopwatch'
import { createAlarms, type ClockAlarm } from './alarms'
import { createPomodoro, pomoPhaseName, type PomoConfig, type PomoState, type PomodoroProfile } from './pomodoro'
import { createSoundPlayer, type AlarmSoundId, type SoundPlayback } from './sounds'
import { createWorldClock, type City } from './worldClock'
import { readStringList, viewEnabled, type Mode } from './preferences'

// ---- Session-scoped store --------------------------------------------------
const STORE_KEY = 'clock.store'
let uid = 0
const genId = (): string => `t${Date.now().toString(36)}${(uid++).toString(36)}`

export interface ClockStore {
  ready: Promise<void>
  flush(): Promise<void>
  updateTimer(id: string, patch: { label?: string; duration?: number }): ClockTimer | null
  setApi(api: ValleyPluginApi): void
  subscribe(fn: () => void): () => void
  notify(): void
  state: {
    mode: Mode
    selectedTimer: string | null
    selectedCity: string | null
    sw: SwState
    timers: ClockTimer[]
    timerDrag: number | null
    timerDrop: { index: number; after: boolean } | null
    worldCities: string[]
    worldDrag: number | null
    worldDrop: { index: number; after: boolean } | null
    /** The tab strip's saved order (ids); empty means the canonical order. */
    tabOrder: string[]
    /** Index of the tab being dragged in the strip, if any. */
    tabDrag: number | null
    tabDrop: { index: number; after: boolean } | null
    pomoProfiles: PomodoroProfile[]
    pomoProfileId: string
    pomoSettingsProfileId: string | null
    pomoProfileDrag: number | null
    pomoProfileDrop: { index: number; after: boolean } | null
    pomo: PomoState
    pick: { h: number; m: number; s: number; label: string }
    alarms: ClockAlarm[]
    alarmDrag: number | null
    alarmDrop: { index: number; after: boolean } | null
    /** Id of the alarm whose inline editor is unfolded, if any. */
    alarmEditing: string | null
    /** Ids of alarms that have fired and are awaiting dismiss/snooze. */
    alarmRinging: string[]
  }
  pomoConfig(): PomoConfig
  pomoProfiles(): PomodoroProfile[]
  selectPomoProfile(id: string): void
  addPomoProfile(name?: string): PomodoroProfile
  renamePomoProfile(id: string, name: string, commit?: boolean): void
  pomoProfileMove(from: number, to: number): boolean
  removePomoProfile(id: string): void
  updatePomoProfile(id: string, patch: Partial<PomoConfig>): void
  /** Persisted display preference for a surface ('analog' default). Only the
   *  clock and the stopwatch have a face to choose — everything else is
   *  digital by design. */
  isDigital(surface: 'clock' | 'stopwatch'): boolean
  /** Re-render every subscriber to reflect changed plugin settings. */
  syncSettings(): void
  // actions
  setMode(m: Mode): void
  swStart(): void
  swStop(): void
  swLap(): void
  swReset(): void
  swElapsed(): number
  addTimer(seconds: number, label?: string): ClockTimer | null
  pauseTimer(id?: string): boolean
  resumeTimer(id?: string): boolean
  cancelTimer(id?: string): boolean
  timerRemaining(t: ClockTimer): number
  timerMove(from: number, to: number): boolean
  worldAdd(query: string): City | null
  worldRemove(tz: string): boolean
  worldMove(from: number, to: number): boolean
  /** Persist the tab strip's order after a drag. */
  setTabOrder(order: Mode[]): void
  defaultSound(): AlarmSoundId
  playSound(id: AlarmSoundId, onDone?: () => void): SoundPlayback | null
  addAlarm(init?: Partial<ClockAlarm>): ClockAlarm
  updateAlarm(id: string, patch: Partial<ClockAlarm>): ClockAlarm | null
  removeAlarm(id: string): ClockAlarm | null
  alarmMove(from: number, to: number): boolean
  toggleAlarm(id: string, on?: boolean): boolean
  dismissAlarm(id: string): void
  snoozeAlarm(id: string): void
  setAlarmEditing(id: string | null): void
  pomoStart(): void
  pomoPause(): void
  pomoReset(): void
  pomoSkip(): void
  pomoRemaining(): number
  /**
   * Attach to the host's notification stream — alarms, timers and Pomodoro all
   * fire from the main process now, so this is how the panel learns about them.
   * Returns a disposer; call it from `register`'s teardown or a hot reload
   * leaves the previous session listening and everything sounds twice.
   */
  listen(api: ValleyPluginApi): () => void
}

function createStore(api: ValleyPluginApi): ClockStore {
  const listeners = new Set<() => void>()
  let apiRef = api
  let pendingWrite: Promise<unknown> = Promise.resolve()
  let notificationSession = 0
  const enqueue = (write: () => Promise<unknown>): void => {
    pendingWrite = pendingWrite.catch(() => {}).then(write)
    void pendingWrite.catch(() => {})
  }
  const soundPlayer = createSoundPlayer()
  const alarms = createAlarms({
    api: () => apiRef,
    enqueue,
    now: () => Date.now(), id: genId, notify: () => notify(),
    removed: (id) => { if (state.alarmEditing === id) state.alarmEditing = null },
    sound: soundPlayer.play, title: () => uiText('auto.25f8c55de811'),
    persistenceError: () => new Error(uiText('surface.invalid'))
  })
  const defaultSound = alarms.defaultSound
  const world = createWorldClock({
    api: () => apiRef,
    enqueue,
    notify: () => notify(),
    persistenceError: () => new Error(uiText('surface.invalid'))
  })
  const timers = createTimers({
    api: () => apiRef,
    enqueue,
    now: () => Date.now(),
    id: genId,
    notify: () => notify(),
    sound: () => soundPlayer.play(defaultSound()),
    title: () => uiText('auto.9d9cec22f36f'),
    formatDuration: fmtCountdown,
    persistenceError: () => new Error(uiText('surface.invalid'))
  })
  const stopwatch = createStopwatch({ api: () => apiRef, enqueue, now: () => Date.now(), notify: () => notify() })
  const pomodoro = createPomodoro({
    api: () => apiRef, enqueue, now: () => Date.now(),
    id: () => `pomodoro-${Date.now().toString(36)}-${uid++}`,
    notify: () => notify(), sound: () => soundPlayer.play(defaultSound()),
    title: () => uiText('auto.212e4618d030'), phaseName: pomoPhaseName,
    persistenceError: () => new Error(uiText('surface.invalid'))
  })

  const state: ClockStore['state'] = {
    mode: 'clock',
    selectedTimer: null,
    selectedCity: null,
    get sw() { return stopwatch.state },
    get timers() { return timers.items },
    timerDrag: null,
    timerDrop: null,
    get worldCities() { return world.items },
    worldDrag: null,
    worldDrop: null,
    tabOrder: [],
    tabDrag: null,
    tabDrop: null,
    get pomoProfiles() { return pomodoro.profiles },
    get pomoProfileId() { return pomodoro.profileId },
    pomoSettingsProfileId: null,
    pomoProfileDrag: null,
    pomoProfileDrop: null,
    get pomo() { return pomodoro.state },
    pick: { h: 0, m: 5, s: 0, label: '' },
    get alarms() { return alarms.items },
    alarmDrag: null,
    alarmDrop: null,
    alarmEditing: null,
    get alarmRinging() { return alarms.ringing }
  }

  const isDigital = (surface: 'clock' | 'stopwatch'): boolean =>
    apiRef.settings.get()[surface === 'clock' ? 'clockDisplay' : 'stopwatchDisplay'] === 'digital'

  const notify = (): void => listeners.forEach((l) => l())

  // Switching a view off while its tab is open would leave the panel on a tab
  // that no longer has a button — and keep its animation loop running.
  const syncSettings = (): void => {
    if (state.mode !== 'clock' && !viewEnabled(state.mode, apiRef.settings.get())) state.mode = 'clock'
    notify()
  }

  const loadPersisted = (): Promise<void> => {
    const cities = readStringList(apiRef.settings.get().worldCities)
    if (cities) world.restore(cities)
    const tabs = readStringList(apiRef.settings.get().tabOrder)
    if (tabs) state.tabOrder = tabs
    const timerOrder = readStringList(apiRef.settings.get().timerOrder) ?? []
    return timers.load(timerOrder)
  }
  const setTabOrder = (order: Mode[]): void => {
    state.tabOrder = [...order]
    const api = apiRef
    const snapshot = JSON.stringify(state.tabOrder)
    enqueue(async () => {
      if (!(await api.settings.set('tabOrder', snapshot)).ok) throw new Error(uiText('surface.invalid'))
    })
    notify()
  }
  const store: ClockStore = {
    ready: Promise.resolve(),
    flush: async () => {
      let observed: Promise<unknown>
      do { observed = pendingWrite; await observed } while (observed !== pendingWrite)
    },
    updateTimer: timers.update,
    setApi: (a) => {
      if (a !== apiRef) { timers.suspend(); stopwatch.suspend(); pomodoro.suspend() }
      apiRef = a
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    notify,
    state,
    pomoConfig: pomodoro.config,
    pomoProfiles: () => pomodoro.profiles,
    selectPomoProfile: pomodoro.selectProfile,
    addPomoProfile: pomodoro.addProfile,
    renamePomoProfile: pomodoro.renameProfile,
    pomoProfileMove: pomodoro.moveProfile,
    removePomoProfile: pomodoro.removeProfile,
    updatePomoProfile: pomodoro.updateProfile,
    isDigital,
    syncSettings,
    setMode: (m) => {
      state.mode = m
      notify()
    },
    swStart: stopwatch.start,
    swStop: stopwatch.stop,
    swLap: stopwatch.lap,
    swReset: stopwatch.reset,
    swElapsed: stopwatch.elapsed,
    addTimer: timers.add,
    pauseTimer: timers.pause,
    resumeTimer: timers.resume,
    cancelTimer: timers.cancel,
    timerRemaining: timers.remaining,
    timerMove: timers.move,
    worldAdd: world.add,
    worldRemove: world.remove,
    worldMove: world.move,
    setTabOrder,
    defaultSound,
    playSound: soundPlayer.play,
    addAlarm: alarms.add,
    updateAlarm: alarms.update,
    removeAlarm: alarms.remove,
    alarmMove: alarms.move,
    toggleAlarm: alarms.toggle,
    dismissAlarm: alarms.dismiss,
    snoozeAlarm: alarms.snooze,
    setAlarmEditing: (id) => {
      state.alarmEditing = id
      notify()
    },
    pomoStart: pomodoro.start,
    pomoPause: pomodoro.pause,
    pomoReset: pomodoro.reset,
    pomoSkip: pomodoro.skip,
    pomoRemaining: pomodoro.remaining,
    /**
     * Subscribe to the host's notification stream. Called once per `register`;
     * the returned disposer is what stops the previous session's handlers
     * surviving a hot reload and firing twice.
     */
    listen: (api) => {
      let listening = true
      const session = ++notificationSession
      store.ready = Promise.all([store.ready, alarms.resumeLoading(), timers.resumeLoading(), stopwatch.resumeLoading(), pomodoro.resumeLoading()]).then(() => {})
      void store.ready.catch(() => {})
      const offRing = api.notifications.onRing(({ key, tick }) => {
        if (!listening || api !== apiRef || session !== notificationSession) return
        if (key.startsWith('alarm:')) alarms.ring(key.slice('alarm:'.length), tick)
        else if (key.startsWith('timer:')) timers.ring(key.slice('timer:'.length), tick)
        else if (key === 'pomodoro') pomodoro.ring()
      })
      const offAction = api.notifications.onAction(({ key, action }) => {
        if (!listening || api !== apiRef || session !== notificationSession || action === 'click') return
        if (key.startsWith('timer:') && action === 'stop') timers.stop(key.slice('timer:'.length))
        if (key.startsWith('alarm:')) alarms.action(key.slice('alarm:'.length), action)
      })
      return () => {
        if (!listening) return
        listening = false
        offRing()
        offAction()
        if (session !== notificationSession) return
        timers.suspend()
        alarms.suspend()
        stopwatch.suspend()
        pomodoro.suspend()
        soundPlayer.stopAll()
      }
      // Nothing cancels the host's schedules here on purpose: outliving this
      // renderer is the entire point of moving them out of it.
    }
  }
  store.ready = Promise.all([loadPersisted(), stopwatch.load(), alarms.load(readStringList(apiRef.settings.get().alarmOrder) ?? []), pomodoro.load()]).then(() => {})
  void store.ready.catch(() => {})
  return store
}

export function getStore(api: ValleyPluginApi): ClockStore {
  const store = api.runtime.getOrCreate(STORE_KEY, () => createStore(api))
  store.setApi(api)
  return store
}

