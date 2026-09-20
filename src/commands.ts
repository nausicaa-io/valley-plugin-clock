import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import type { ClockStore } from './store'
import type { Mode } from './preferences'
import { parseClockTime, parseDays, type ClockAlarm } from './alarms'
import { fmtStopwatch } from './stopwatch'
import { fmtCountdown, parseDuration } from './timers'
import { cityId, cityFor, cityZone, cityName, cityMatches, normalizeCityTerm, cityTime } from './worldClock'

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
    offs.push(api.commands.register({ ...cmd,
      ...(cmd.sideEffect === 'write' && !cmd.revision ? { revision: async () => { await store.ready; const { mode, sw, timers, worldCities, alarms, pomo } = store.state; return { mode, sw, timers, worldCities, alarms, pomo, clockDisplay: store.isDigital('clock'), stopwatchDisplay: store.isDigital('stopwatch') } } } : {}),
      run: async (input: I, context) => { await store.ready; const output = await cmd.run(input, context); if (cmd.sideEffect === 'write') await store.flush(); return output }
    }))
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
      store.setMode(mode)
      return { value: { mode }, revert: rev('Switch clock tab', () => store.setMode(prev)) }
    },
    formatCli: (v) => `Clock: ${v.mode}`
  })

  // Display style (persisted setting; drives the analog/digital face). Only the
  // clock and the stopwatch have one — timers and Pomodoro are always digital.
  const DISPLAY_KEY = { clock: 'clockDisplay', stopwatch: 'stopwatchDisplay' } as const
  reg({
    id: 'display',
    label: "Clock: Set display style", labelKey: 'auto.6e4df07e9445',
    paletteSafe: false,
    sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { surface: { enum: ['clock', 'stopwatch'] }, style: { enum: ['analog', 'digital'] } }, required: ['surface', 'style'], additionalProperties: false },
      parse: (raw) => {
        const surface = str(raw, 'surface').toLowerCase()
        const style = str(raw, 'style').toLowerCase()
        if (!['clock', 'stopwatch'].includes(surface) || !['analog', 'digital'].includes(style))
          throw new Error('Usage: clock display <clock|stopwatch> <analog|digital>')
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
      if (!(await api.settings.set(key, style)).ok) throw new Error(uiText('surface.invalid'))
      store.syncSettings()
      return {
        value: { surface, style },
        revert: rev('Restore display style', async () => {
          if (!(await api.settings.set(key, prev)).ok) throw new Error(uiText('surface.invalid'))
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
      store.swStart()
      return { value: { running: true }, revert: rev('Stop stopwatch', () => store.swStop()) }
    },
    formatCli: () => 'Stopwatch started'
  })
  reg({
    id: 'sw-stop',
    label: "Clock: Stop stopwatch", labelKey: 'auto.557994cd7327',
    sideEffect: 'write',
    run: () => {
      store.swStop()
      return { value: { elapsed: store.swElapsed() }, revert: rev('Resume stopwatch', () => store.swStart()) }
    },
    formatCli: (v) => `Stopwatch stopped at ${fmtStopwatch(v.elapsed)}`
  })
  reg({
    id: 'sw-lap',
    label: "Clock: Lap stopwatch", labelKey: 'auto.ef22d051b2c7',
    sideEffect: 'write',
    run: () => {
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
    run: ({ seconds, label }) => {
      const t = store.addTimer(seconds, label)
      if (!t) throw new Error('Could not create timer.')
      return { value: { id: t.id, duration: t.duration, label: t.label }, revert: rev('Cancel timer', () => store.cancelTimer(t.id)) }
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
    run: ({ id }) => {
      const ok = store.pauseTimer(id)
      return { value: { paused: ok }, revert: rev('Resume timer', () => store.resumeTimer(id)) }
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
    run: ({ id }) => {
      const ok = store.resumeTimer(id)
      return { value: { resumed: ok }, revert: rev('Pause timer', () => store.pauseTimer(id)) }
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
      const ok = store.cancelTimer(id)
      return { value: { cancelled: ok }, revert: null }
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
    run: ({ query }) => {
      const city = store.worldAdd(query)
      if (!city) throw new Error(`No known city matching "${query}".`)
      return { value: { name: city.name, tz: city.tz }, revert: rev('Remove city', () => store.worldRemove(cityId(city))) }
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
    run: ({ query }) => {
      const normalized = normalizeCityTerm(query)
      const match =
        store.state.worldCities.find((id) => id.toLowerCase() === query.toLowerCase()) ??
        store.state.worldCities.find((id) => normalizeCityTerm(cityName(id)) === normalized) ??
        store.state.worldCities.find((id) => {
          const city = cityFor(id)
          return city ? cityMatches(city, query) : normalizeCityTerm(cityName(id)).includes(normalized)
        })
      if (!match) throw new Error(`No world city matching "${query}".`)
      const ok = store.worldRemove(match)
      return { value: { removed: ok, tz: cityZone(match) }, revert: rev('Add city', () => store.worldAdd(match)) }
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
    run: ({ query, position }) => {
      const q = normalizeCityTerm(query)
      let from = store.state.worldCities.findIndex((id) => id.toLowerCase() === query.toLowerCase())
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)) === q)
      if (from < 0) from = store.state.worldCities.findIndex((id) => normalizeCityTerm(cityName(id)).includes(q))
      if (from < 0) throw new Error(`"${query}" is not in the world list.`)
      const to = Math.min(Math.max(position - 1, 0), store.state.worldCities.length - 1)
      const ok = store.worldMove(from, to)
      const tz = store.state.worldCities[to]
      return { value: { moved: ok, tz, position: to + 1 }, revert: rev('Move city back', () => store.worldMove(to, from)) }
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
    run: ({ hour, minute, label, days }) => {
      if (hour < 0) throw new Error('Usage: clock alarm-add <HH:MM> [--label "Wake up"] [--days mon,tue]')
      const a = store.addAlarm({ hour, minute, label, days })
      return { value: { id: a.id, hour: a.hour, minute: a.minute, label: a.label }, revert: rev('Remove alarm', () => void store.removeAlarm(a.id)) }
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
    run: ({ query }) => {
      const a = findAlarm(store, query)
      if (!a) throw new Error(`No alarm matching "${query}".`)
      const snapshot = { ...a }
      store.removeAlarm(a.id)
      return {
        value: { id: a.id, removed: true },
        revert: rev('Restore alarm', () => void store.addAlarm(snapshot))
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
    run: ({ query }) => {
      const a = findAlarm(store, query)
      if (!a) throw new Error(`No alarm matching "${query}".`)
      const was = a.enabled
      const now = store.toggleAlarm(a.id)
      return { value: { id: a.id, enabled: now }, revert: rev('Restore alarm state', () => void store.toggleAlarm(a.id, was)) }
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
    run: () => {
      store.pomoStart()
      return { value: { phase: store.state.pomo.phase }, revert: rev('Pause Pomodoro', () => store.pomoPause()) }
    },
    formatCli: (v) => `Pomodoro started (${v.phase})`
  })
  reg({
    id: 'pomodoro-pause',
    label: "Clock: Pause Pomodoro", labelKey: 'auto.595d0b10adc0',
    sideEffect: 'write',
    run: () => {
      store.pomoPause()
      return { value: { paused: true }, revert: rev('Resume Pomodoro', () => store.pomoStart()) }
    },
    formatCli: () => 'Pomodoro paused'
  })
  reg({
    id: 'pomodoro-reset',
    label: "Clock: Reset Pomodoro", labelKey: 'auto.5aee8fbc51d9',
    sideEffect: 'write',
    run: () => {
      store.pomoReset()
      return { value: { reset: true }, revert: null }
    },
    formatCli: () => 'Pomodoro reset'
  })
  reg({
    id: 'pomodoro-skip',
    label: "Clock: Skip Pomodoro phase", labelKey: 'auto.53b04ab58b1c',
    sideEffect: 'write',
    run: () => {
      store.pomoSkip()
      return { value: { phase: store.state.pomo.phase }, revert: null }
    },
    formatCli: (v) => `Skipped to ${v.phase}`
  })

  return offs
}
