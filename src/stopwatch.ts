import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { readClockFile, writeClockFile } from './persistence'

export interface SwState {
  running: boolean
  startedAt: number
  elapsed: number
  laps: number[]
}

interface StopwatchPorts {
  api(): Pick<ValleyPluginApi, 'data'>
  enqueue(write: () => Promise<unknown>): void
  now(): number
  notify(): void
}

export function createStopwatch(ports: StopwatchPorts) {
  let state: SwState = { running: false, startedAt: 0, elapsed: 0, laps: [] }
  let generation = 0
  let loading = false
  let reloadNeeded = false
  const elapsed = (): number => state.elapsed + (state.running ? Math.max(0, ports.now() - state.startedAt) : 0)
  const changed = (): void => {
    generation++
    loading = false
    reloadNeeded = false
    const api = ports.api()
    const snapshot = { ...state, laps: [...state.laps] }
    ports.enqueue(() => writeClockFile(api, 'stopwatch.json', snapshot))
    ports.notify()
  }
  const load = async (): Promise<void> => {
    const api = ports.api()
    const revision = ++generation
    const current = (): boolean => revision === generation && api === ports.api()
    loading = true
    reloadNeeded = false
    try {
      const record = await readClockFile<SwState>(api, 'stopwatch.json')
      if (!current() || !record) return
      const startedAt = Number(record.startedAt)
      const running = !!record.running && Number.isFinite(startedAt) && startedAt > 0
      const savedElapsed = Number(record.elapsed)
      state = {
        running, startedAt: running ? startedAt : 0,
        elapsed: Number.isFinite(savedElapsed) ? Math.max(0, savedElapsed) : 0,
        laps: (Array.isArray(record.laps) ? record.laps : []).map(Number).filter(value => Number.isFinite(value) && value >= 0)
      }
      ports.notify()
    } catch (error) {
      if (current()) throw error
    } finally { if (revision === generation) loading = false }
  }
  return {
    get state(): SwState { return state },
    elapsed,
    load,
    suspend(): void { if (loading) reloadNeeded = true; loading = false; generation++ },
    resumeLoading(): Promise<void> { return reloadNeeded ? load() : Promise.resolve() },
    start(): void {
      if (state.running) return
      state.startedAt = ports.now()
      state.running = true
      changed()
    },
    stop(): void {
      if (!state.running) return
      state.elapsed = elapsed()
      state.running = false
      state.startedAt = 0
      changed()
    },
    lap(): void {
      if (!state.running) return
      state.laps.unshift(elapsed())
      changed()
    },
    restore(next: SwState): void {
      state = { running: next.running, startedAt: next.startedAt, elapsed: next.elapsed, laps: [...next.laps] }
      changed()
    },
    reset(): void {
      state = { running: false, startedAt: 0, elapsed: 0, laps: [] }
      changed()
    }
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function fmtStopwatch(ms: number): string {
  const cs = Math.floor((ms % 1000) / 10)
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const hrs = Math.floor(ms / 3600000)
  const head = hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  return `${head}.${pad(cs)}`
}
