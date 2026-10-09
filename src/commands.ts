import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import type { ClockStore } from './store'
import type { Mode } from './preferences'
import { parseClockTime, parseDays, type ClockAlarm } from './alarms'
import { fmtStopwatch } from './stopwatch'
import { fmtCountdown, parseDuration, timerRunState, type ClockTimer, type TimerRunState } from './timers'
import { cityId, cityFor, cityZone, cityName, cityMatches, normalizeCityTerm, cityTime, findCity } from './worldClock'
import { samePomoState, type PomoState } from './pomodoro'

const resultText = { type: 'string', maxLength: 16384 }
const resultFlag = { type: 'boolean' }
const resultNumber = { type: 'number', minimum: 0 }
const resultCount = { type: 'integer', minimum: 0 }
const resultObject = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const resultList = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'array', maxItems: 10000, items: resultObject(properties) })
const phaseResult = resultObject({ phase: { type: 'string', enum: ['work', 'short', 'long'] } })
const commandResults: Record<string, Record<string, unknown>> = {
  mode: resultObject({ mode: { type: 'string', enum: ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro'] } }),
  display: resultObject({ surface: { const: 'stopwatch' }, style: { type: 'string', enum: ['analog', 'digital'] } }),
  'sw-start': resultObject({ running: resultFlag }), 'sw-stop': resultObject({ elapsed: resultNumber }),
  'sw-lap': resultObject({ laps: resultCount }), 'sw-reset': resultObject({ reset: resultFlag }),
  'timer-start': resultObject({ id: resultText, duration: resultNumber, label: resultText }),
  'timer-pause': resultObject({ paused: resultFlag }), 'timer-resume': resultObject({ resumed: resultFlag }),
  'timer-cancel': resultObject({ cancelled: resultFlag }),
  'timer-list': resultObject({ timers: resultList({ id: resultText, label: resultText, remaining: resultNumber, running: resultFlag }) }),
  'world-add': resultObject({ name: resultText, tz: resultText }), 'world-remove': resultObject({ removed: resultFlag, tz: resultText }),
  'world-list': resultObject({ cities: resultList({ name: resultText, tz: resultText, time: resultText }) }),
  'world-move': resultObject({ moved: resultFlag, tz: resultText, position: { type: 'integer', minimum: 1 } }),
  'alarm-add': resultObject({ id: resultText, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 }, label: resultText }),
  'alarm-remove': resultObject({ id: resultText, removed: resultFlag }), 'alarm-toggle': resultObject({ id: resultText, enabled: resultFlag }),
  'alarm-list': resultObject({ alarms: resultList({ id: resultText, text: resultText }) }),
  'pomodoro-start': phaseResult, 'pomodoro-pause': resultObject({ paused: resultFlag }),
  'pomodoro-reset': resultObject({ reset: resultFlag }), 'pomodoro-skip': phaseResult
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Resolve a CLI alarm reference: exact id, then "HH:MM", then a label match. */
function findAlarm(store: ClockStore, query: string): ClockAlarm | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return store.state.alarms[store.state.alarms.length - 1]
  const byId = store.state.alarms.find((a) => a.id === query.trim())
  if (byId) return byId
  const t = parseClockTime(q)
  if (t) {
    const byTime = store.state.alarms.find((a) => a.hour === t.hour && a.minute === t.minute)
    if (byTime) return byTime
  }
  return store.state.alarms.find((a) => a.label.toLowerCase().includes(q))
}

// ---- Commands --------------------------------------------------------------
export function registerCommands(api: ValleyPluginApi, store: ClockStore): Array<() => void> {
  const offs: Array<() => void> = []
  const reg = <I, O, E extends 'read' | 'write'>(cmd: PluginCommand<I, O, E>): void => {
    const outputSchema = commandResults[cmd.id]
    if (!outputSchema) throw new Error(`Clock result contract is missing: ${cmd.id}`)
    const registration: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> } = { ...cmd, outputSchema,
      ...(!cmd.input ? { input: { schema: resultObject({}), parse: () => undefined as I } } : {}),
      ...(cmd.sideEffect === 'write' && !cmd.revision ? { revision: async () => { await store.ready; const { mode, sw, timers, worldCities, alarms, pomo } = store.state; return { mode, sw, timers, worldCities, alarms, pomo, stopwatchDisplay: store.isDigital('stopwatch') } } } : {}),
      run: async (input: I, context) => { await store.ready; const output = await cmd.run(input, context); if (cmd.sideEffect === 'write') await store.flush(); return output }
    }
    offs.push(api.commands.register(registration))
  }
  const str = (o: unknown, k: string): string => {
    const v = (o as Record<string, unknown>)?.[k]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  }
  // Wrap a synchronous inverse as the bus's RevertOperation (one ⌘Z entry).
  const rev = (label: string, run: () => unknown): { label: string; run: () => Promise<void> } => ({
    label,
    run: async () => {
      await run()
      await store.flush()
    }
  })
  // Refusals before any effect: the caller learns nothing changed.
  const unavailable = (message: string): Error => Object.assign(new Error(message), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
  const conflict = (message: string): Error => Object.assign(new Error(message), { code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  const stopwatchUnavailable = unavailable
  const stopwatchReady = (running?: boolean, message = ''): void => {
    if (!store.swReady()) throw stopwatchUnavailable('The stopwatch has not loaded its saved state yet.')
    if (running !== undefined && store.state.sw.running !== running) throw stopwatchUnavailable(message)
  }

  const timerUnavailable = unavailable
  const timerReady = (id: string | undefined, running: boolean, message: string): ClockTimer => {
    const target = id ? store.state.timers.find((t) => t.id === id) : store.state.timers.at(-1)
    if (!target) throw timerUnavailable(id ? `No timer with id "${id}".` : 'There is no timer.')
    if (target.running !== running) throw timerUnavailable(message)
    return target
  }
  // The backend owns the authoritative timer fields; capture them after the change lands.
  // A timer that vanished meanwhile keeps `fallback`, and its restore then refuses as a conflict.
  const settledTimer = async (timerId: string, fallback: TimerRunState): Promise<TimerRunState> => {
    await store.flush()
    const settled = store.state.timers.find((t) => t.id === timerId)
    return settled ? timerRunState(settled) : fallback
  }

  const pomodoroReady = (running?: boolean, message = ''): PomoState => {
    if (!store.pomoReady()) throw unavailable('The Pomodoro has not loaded its saved state yet.')
    if (running !== undefined && store.state.pomo.running !== running) throw unavailable(message)
    return structuredClone(store.state.pomo)
  }
  // The backend owns the Pomodoro; a change it did not apply is reported as not applied.
  const settledPomodoro = async (before: PomoState): Promise<PomoState> => {
    await store.flush()
    const after = structuredClone(store.state.pomo)
    if (samePomoState(after, before)) throw unavailable('The Pomodoro did not change.')
    return after
  }

  reg({
    id: 'mode',
    label: "Clock: Switch tab", labelKey: 'auto.6b1b8322b245',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { mode: { enum: ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro'] } }, required: ['mode'], additionalProperties: false },
      parse: (raw) => {
        const m = str(raw, 'mode').toLowerCase()
        const valid = ['clock', 'alarm', 'stopwatch', 'timer', 'pomodoro']
        if (!valid.includes(m)) throw new Error(`Usage: clock mode <${valid.join('|')}>`)
        return { mode: m as Mode }
      },
      fromCli: (args) => {
        const m = (args[0] ?? '').toLowerCase()
        return { mode: m as Mode }
      }
    },
    run: ({ mode }) => {
      const prev = store.state.mode
      if (prev === mode) throw unavailable(`The Clock already shows the ${mode} tab.`)
      store.setMode(mode)
      return { value: { mode }, revert: rev('Switch clock tab', () => {
        if (store.state.mode !== mode) throw conflict('The Clock tab changed; read it before switching back.')
        store.setMode(prev)
      }) }
    },
    formatCli: (v) => `Clock: ${v.mode}`
  })

  const DISPLAY_KEY = { stopwatch: 'stopwatchDisplay' } as const
  reg({
    id: 'display',
    label: "Clock: Set display style", labelKey: 'auto.6e4df07e9445',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { surface: { enum: ['stopwatch'] }, style: { enum: ['analog', 'digital'] } }, required: ['surface', 'style'], additionalProperties: false },
      parse: (raw) => {
        const surface = str(raw, 'surface').toLowerCase()
        const style = str(raw, 'style').toLowerCase()
        if (surface !== 'stopwatch' || !['analog', 'digital'].includes(style))
          throw new Error('Usage: clock display stopwatch <analog|digital>')
        return { surface: surface as keyof typeof DISPLAY_KEY, style: style as 'analog' | 'digital' }
      },
      fromCli: (args) => ({
        surface: (args[0] ?? '').toLowerCase() as keyof typeof DISPLAY_KEY,
        style: (args[1] ?? '').toLowerCase() as 'analog' | 'digital'
      })
    },
    run: async ({ surface, style }) => {
      const key = DISPLAY_KEY[surface]
      const prev: 'analog' | 'digital' = store.isDigital(surface) ? 'digital' : 'analog'
      if (prev === style) throw unavailable(`The ${surface} already uses the ${style} display.`)
      const saved = api.settings.get()[key]
      if (!(await api.settings.set(key, style)).ok) throw new Error(uiText('surface.invalid'))
      store.syncSettings()
      return {
        value: { surface, style },
        revert: rev('Restore display style', async () => {
          if ((store.isDigital(surface) ? 'digital' : 'analog') !== style) throw conflict(`The ${surface} display changed; read it before restoring.`)
          if (!(await api.settings.set(key, saved ?? prev)).ok) throw new Error(uiText('surface.invalid'))
          store.syncSettings()
        })
      }
    },
    formatCli: (v) => `${v.surface} display set to ${v.style}`
  })

  // Stopwatch
  reg({
    id: 'sw-start',
    label: "Clock: Start stopwatch", labelKey: 'auto.bc5b66e6c26b',
    sideEffect: 'write',
    run: () => {
      stopwatchReady(false, 'The stopwatch is already running.')
      const before = structuredClone(store.state.sw)
      store.swStart()
      const revision = store.swRevision()
      return { value: { running: true }, revert: rev('Stop stopwatch', () => store.swRestore(before, revision)) }
    },
    formatCli: () => 'Stopwatch started'
  })
  reg({
    id: 'sw-stop',
    label: "Clock: Stop stopwatch", labelKey: 'auto.557994cd7327',
    sideEffect: 'write',
    run: () => {
      stopwatchReady(true, 'The stopwatch is not running.')
      const before = structuredClone(store.state.sw)
      store.swStop()
      const revision = store.swRevision()
      return { value: { elapsed: store.swElapsed() }, revert: rev('Resume stopwatch', () => store.swRestore(before, revision)) }
    },
    formatCli: (v) => `Stopwatch stopped at ${fmtStopwatch(v.elapsed)}`
  })
  reg({
    id: 'sw-lap',
    label: "Clock: Lap stopwatch", labelKey: 'auto.ef22d051b2c7',
    sideEffect: 'write',
    run: () => {
      stopwatchReady(true, 'Start the stopwatch before recording a lap.')
      store.swLap()
      return { value: { laps: store.state.sw.laps.length }, revert: null }
    },
    formatCli: (v) => `Lap ${v.laps} recorded`
  })
  reg({
    id: 'sw-reset',
    label: "Clock: Reset stopwatch", labelKey: 'auto.bbb44faa3c13',
    sideEffect: 'write',
    run: () => {
      stopwatchReady()
      const sw = store.state.sw
      if (!sw.running && sw.startedAt === 0 && sw.elapsed === 0 && sw.laps.length === 0) throw unavailable('The stopwatch is already reset.')
      store.swReset()
      return { value: { reset: true }, revert: null }
    },
    formatCli: () => 'Stopwatch reset'
  })

  // Timers
  reg({
    id: 'timer-start',
    label: "Clock: Start a timer", labelKey: 'auto.a6575150b41a',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { duration: { type: 'string', minLength: 1 }, label: { type: 'string' } }, required: ['duration'], additionalProperties: false },
      parse: (raw) => {
        const secs = parseDuration(str(raw, 'duration'))
        if (secs <= 0) throw new Error('Usage: clock timer-start <duration e.g. 5m> [--label "Tea"]')
        return { seconds: secs, label: str(raw, 'label') }
      },
      fromCli: (args, flags) => ({
        duration: args.join(' '),
        label: typeof flags.label === 'string' ? flags.label : ''
      })
    },
    run: async ({ seconds, label }) => {
      const t = store.addTimer(seconds, label)
      if (!t) throw unavailable('Could not create timer.')
      await store.flush()
      const created = store.state.timers.find((timer) => timer.id === t.id) ?? t
      const after = structuredClone(created)
      return { value: { id: created.id, duration: created.duration, label: created.label }, revert: rev('Cancel timer', () => store.discardTimer(t.id, after)) }
    },
    formatCli: (v) => `Timer started: ${fmtCountdown(v.duration)}${v.label ? ` (${v.label})` : ''}`
  })
  reg({
    id: 'timer-pause',
    label: "Clock: Pause a timer", labelKey: 'auto.8002918e458d',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: async ({ id }) => {
      const target = timerReady(id, true, 'The timer is not running.')
      const before = timerRunState(target)
      if (!store.pauseTimer(target.id)) throw timerUnavailable('The timer is not running.')
      const after = await settledTimer(target.id, before)
      return { value: { paused: true }, revert: rev('Resume timer', () => store.restoreTimer(target.id, after, before)) }
    },
    formatCli: (v) => (v.paused ? 'Timer paused' : 'No running timer')
  })
  reg({
    id: 'timer-resume',
    label: "Clock: Resume a timer", labelKey: 'auto.3db28890b6e6',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: async ({ id }) => {
      const target = timerReady(id, false, 'The timer is not paused.')
      if (target.remaining <= 0) throw timerUnavailable('The timer has already finished.')
      const before = timerRunState(target)
      if (!store.resumeTimer(target.id)) throw timerUnavailable('The timer is not paused.')
      const after = await settledTimer(target.id, before)
      return { value: { resumed: true }, revert: rev('Pause timer', () => store.restoreTimer(target.id, after, before)) }
    },
    formatCli: (v) => (v.resumed ? 'Timer resumed' : 'No paused timer')
  })
  reg({
    id: 'timer-cancel',
    label: "Clock: Cancel a timer", labelKey: 'auto.9ffe5ff9b2a2',
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ id: str(raw, 'id') || undefined }),
      fromCli: (args) => ({ id: args[0] || undefined })
    },
    run: ({ id }) => {
      const target = id ? store.state.timers.find((t) => t.id === id) : store.state.timers.at(-1)
      if (!target) throw timerUnavailable(id ? `No timer with id "${id}".` : 'There is no timer.')
      if (!store.cancelTimer(target.id)) throw timerUnavailable('There is no timer.')
      return { value: { cancelled: true }, revert: null }
    },
    formatCli: (v) => (v.cancelled ? 'Timer cancelled' : 'No timer')
  })
  reg({
    id: 'timer-list',
    label: "Clock: List timers", labelKey: 'auto.fdb76665287e',
    sideEffect: 'read',
    run: () => ({
      timers: store.state.timers.map((t) => ({
        id: t.id,
        label: t.label,
        remaining: store.timerRemaining(t),
        running: t.running
      }))
    }),
    formatCli: (v) =>
      v.timers.length
        ? v.timers.map((t) => `${t.id} ${fmtCountdown(t.remaining)}${t.running ? '' : ' (paused)'}${t.label ? ` ${t.label}` : ''}`).join('\n')
        : 'No timers'
  })

  // World clock
  reg({
    id: 'world-add',
    label: "Clock: Add a world city", labelKey: 'auto.09d77f0a794a',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        if (!q) throw new Error('Usage: clock world-add "<city>"')
        return { query: q }
      },
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: async ({ query }) => {
      const known = findCity(query)
      if (!known) throw unavailable(`No known city matching "${query}".`)
      await store.flush()
      if (store.state.worldCities.includes(cityId(known))) throw unavailable(`${known.name} is already in the world list.`)
      const before = [...store.state.worldCities]
      const saved = api.settings.get().worldCities
      const city = store.worldAdd(query)
      if (!city) throw unavailable(`No known city matching "${query}".`)
      const after = [...store.state.worldCities]
      return { value: { name: city.name, tz: city.tz }, revert: rev('Remove city', () => store.worldRestore(after, before, saved)) }
    },
    formatCli: (v) => `Added ${v.name} (${cityTime(v.tz, new Date())})`
  })
  reg({
    id: 'world-remove',
    label: "Clock: Remove a world city", labelKey: 'auto.aba9b24a1f72',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        if (!q) throw new Error('Usage: clock world-remove "<city>"')
        return { query: q }
      },
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: async ({ query }) => {
      await store.flush()
      const normalized = normalizeCityTerm(query)
      const match =
        store.state.worldCities.find((id) => id.toLowerCase() === query.toLowerCase()) ??
        store.state.worldCities.find((id) => normalizeCityTerm(cityName(id)) === normalized) ??
        store.state.worldCities.find((id) => {
          const city = cityFor(id)
          return city ? cityMatches(city, query) : normalizeCityTerm(cityName(id)).includes(normalized)
        })
      if (!match) throw unavailable(`No world city matching "${query}".`)
      const before = [...store.state.worldCities]
      const saved = api.settings.get().worldCities
      if (!store.worldRemove(match)) throw unavailable(`No world city matching "${query}".`)
      const after = [...store.state.worldCities]
      return { value: { removed: true, tz: cityZone(match) }, revert: rev('Add city', () => store.worldRestore(after, before, saved)) }
    },
    formatCli: (v) => (v.removed ? 'City removed' : 'City was not in the list')
  })
  reg({
    id: 'world-list',
    label: "Clock: List world cities", labelKey: 'auto.6a65a293678d',
    sideEffect: 'read',
    run: () => {
      const now = new Date()
      return { cities: store.state.worldCities.map((id) => ({ name: cityName(id), tz: cityZone(id), time: cityTime(id, now) })) }
    },
    formatCli: (v) => (v.cities.length ? v.cities.map((c) => `${c.time}  ${c.name}`).join('\n') : 'No cities')
  })
  reg({
    id: 'world-move',
    label: "Clock: Reorder a world city", labelKey: 'auto.b3c6e9298c12',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { city: { type: 'string', minLength: 1 }, tz: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 }, position: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => {
        const q = str(raw, 'city') || str(raw, 'tz') || str(raw, 'query')
        const pos = Number(str(raw, 'position') || str(raw, 'to'))
        if (!q || !Number.isFinite(pos) || pos < 1) throw new Error('Usage: clock world-move "<city>" <position>')
        return { query: q, position: Math.floor(pos) }
      },
      fromCli: (args) => {
        const position = Number(args[args.length - 1])
        return {
          query: args.slice(0, -1).join(' '),
          position: Number.isFinite(position) ? Math.floor(position) : 0
        }
      }
    },
    run: async ({ query, position }) => {
      await store.flush()
      const q = normalizeCityTerm(query)
      let from = store.state.worldCities.findIndex((id) => id.toLowerCase() === query.toLowerCase())
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)) === q)
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)).includes(q))
      if (from < 0) throw unavailable(`"${query}" is not in the world list.`)
      const to = Math.min(Math.max(position - 1, 0), store.state.worldCities.length - 1)
      if (from === to) throw unavailable(`${cityName(store.state.worldCities[from])} is already at position ${to + 1}.`)
      const before = [...store.state.worldCities]
      const saved = api.settings.get().worldCities
      if (!store.worldMove(from, to)) throw unavailable(`${cityName(store.state.worldCities[from])} is already at position ${to + 1}.`)
      const after = [...store.state.worldCities]
      return { value: { moved: true, tz: after[to], position: to + 1 }, revert: rev('Move city back', () => store.worldRestore(after, before, saved)) }
    },
    formatCli: (v) => (v.moved ? `Moved ${cityName(v.tz)} to position ${v.position}` : 'City already in place')
  })

  // Alarms
  const fmtAlarm = (a: ClockAlarm): string =>
    `${pad(a.hour)}:${pad(a.minute)}${a.label ? ` ${a.label}` : ''}${a.enabled ? '' : ' (off)'}`
  reg({
    id: 'alarm-add',
    label: "Clock: Add an alarm", labelKey: 'auto.66ddbbee498d',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { time: { type: 'string', minLength: 1 }, label: { type: 'string' }, days: { type: 'string' } }, required: ['time'], additionalProperties: false },
      parse: (raw) => {
        const t = parseClockTime(str(raw, 'time'))
        if (!t) throw new Error('Usage: clock alarm-add <HH:MM> [--label "Wake up"] [--days mon,tue]')
        return { hour: t.hour, minute: t.minute, label: str(raw, 'label'), days: parseDays(str(raw, 'days')) }
      },
      fromCli: (args, flags) => ({ time: args[0] ?? '', label: typeof flags.label === 'string' ? flags.label : '', days: typeof flags.days === 'string' ? flags.days : '' })
    },
    run: async ({ hour, minute, label, days }) => {
      if (hour < 0) throw unavailable('Usage: clock alarm-add <HH:MM> [--label "Wake up"] [--days mon,tue]')
      const a = store.addAlarm({ hour, minute, label, days })
      await store.flush()
      const after = structuredClone(store.state.alarms.find((alarm) => alarm.id === a.id) ?? a)
      return { value: { id: after.id, hour: after.hour, minute: after.minute, label: after.label }, revert: rev('Remove alarm', () => store.restoreAlarm(a.id, after, null)) }
    },
    formatCli: (v) => `Alarm set for ${pad(v.hour)}:${pad(v.minute)}${v.label ? ` (${v.label})` : ''}`
  })
  reg({
    id: 'alarm-remove',
    label: "Clock: Remove an alarm", labelKey: 'auto.82d01f840bd9',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, alarm: { type: 'string', minLength: 1 }, time: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ query: str(raw, 'id') || str(raw, 'alarm') || str(raw, 'time') || str(raw, 'query') }),
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: async ({ query }) => {
      await store.flush()
      const a = findAlarm(store, query)
      if (!a) throw unavailable(`No alarm matching "${query}".`)
      const snapshot = structuredClone(a)
      const index = store.state.alarms.indexOf(a)
      if (!store.removeAlarm(a.id)) throw unavailable(`No alarm matching "${query}".`)
      return {
        value: { id: a.id, removed: true },
        revert: rev('Restore alarm', () => store.restoreAlarm(snapshot.id, null, snapshot, index))
      }
    },
    formatCli: () => 'Alarm removed'
  })
  reg({
    id: 'alarm-toggle',
    label: "Clock: Toggle an alarm", labelKey: 'auto.091f8858665b',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, alarm: { type: 'string', minLength: 1 }, time: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } }, required: [], additionalProperties: false },
      parse: (raw) => ({ query: str(raw, 'id') || str(raw, 'alarm') || str(raw, 'time') || str(raw, 'query') }),
      fromCli: (args) => ({ query: args.join(' ') })
    },
    run: async ({ query }) => {
      await store.flush()
      const a = findAlarm(store, query)
      if (!a) throw unavailable(`No alarm matching "${query}".`)
      const before = structuredClone(a)
      store.toggleAlarm(a.id)
      await store.flush()
      const settled = store.state.alarms.find((alarm) => alarm.id === a.id)
      const after = settled ? structuredClone(settled) : { ...before, enabled: !before.enabled }
      return { value: { id: a.id, enabled: after.enabled }, revert: rev('Restore alarm state', () => store.restoreAlarm(a.id, after, before)) }
    },
    formatCli: (v) => (v.enabled ? 'Alarm enabled' : 'Alarm disabled')
  })
  reg({
    id: 'alarm-list',
    label: "Clock: List alarms", labelKey: 'auto.aa21c27f35a8',
    sideEffect: 'read',
    run: () => ({ alarms: store.state.alarms.map((a) => ({ id: a.id, text: fmtAlarm(a) })) }),
    formatCli: (v) => (v.alarms.length ? v.alarms.map((a) => `${a.id}  ${a.text}`).join('\n') : 'No alarms')
  })

  // Pomodoro
  reg({
    id: 'pomodoro-start',
    label: "Clock: Start Pomodoro", labelKey: 'auto.f65ee22b00b8',
    sideEffect: 'write',
    run: async () => {
      const before = pomodoroReady(false, 'The Pomodoro is already running.')
      store.pomoStart()
      const after = await settledPomodoro(before)
      return { value: { phase: after.phase }, revert: rev('Pause Pomodoro', () => store.pomoRestore(after, before)) }
    },
    formatCli: (v) => `Pomodoro started (${v.phase})`
  })
  reg({
    id: 'pomodoro-pause',
    label: "Clock: Pause Pomodoro", labelKey: 'auto.595d0b10adc0',
    sideEffect: 'write',
    run: async () => {
      const before = pomodoroReady(true, 'The Pomodoro is not running.')
      store.pomoPause()
      const after = await settledPomodoro(before)
      return { value: { paused: true }, revert: rev('Resume Pomodoro', () => store.pomoRestore(after, before)) }
    },
    formatCli: () => 'Pomodoro paused'
  })
  reg({
    id: 'pomodoro-reset',
    label: "Clock: Reset Pomodoro", labelKey: 'auto.5aee8fbc51d9',
    sideEffect: 'write',
    run: () => {
      const pomo = pomodoroReady()
      if (samePomoState(pomo, { phase: 'work', cycle: 0, running: false, endsAt: 0, remaining: store.pomoConfig().work * 60_000 })) throw unavailable('The Pomodoro is already reset.')
      store.pomoReset()
      return { value: { reset: true }, revert: null }
    },
    formatCli: () => 'Pomodoro reset'
  })
  reg({
    id: 'pomodoro-skip',
    label: "Clock: Skip Pomodoro phase", labelKey: 'auto.53b04ab58b1c',
    sideEffect: 'write',
    run: async () => {
      pomodoroReady()
      store.pomoSkip()
      await store.flush()
      return { value: { phase: store.state.pomo.phase }, revert: null }
    },
    formatCli: (v) => `Skipped to ${v.phase}`
  })

  return offs
}
