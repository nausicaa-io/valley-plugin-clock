import { describe, expect, it } from 'vitest'
import { createMockValleyApi } from './harness'
import { register } from '../src/index'
import type { ClockStore } from '../src/index'

const unavailable = { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false }
const conflict = { code: 'REVISION_CONFLICT', outcome: 'not-applied' }
const tick = () => new Promise(resolve => setTimeout(resolve, 15))

function setup(settings: Record<string, unknown> = {}) {
  const mock = createMockValleyApi({ manifest: { id: 'clock' }, settings })
  const off = register(mock.api)
  const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('missing store') })
  const run = (id: string, input?: unknown) => mock.commands.find((command) => command.id === id)!.run((input ?? {}) as never, { caller: 'agent' })
  const execute = async (id: string, input?: unknown) => {
    const result = await mock.api.commands.execute(`clock:${id}`, input)
    expect(result.ok, `${id}: ${JSON.stringify(result)}`).toBe(true)
    return (result as { value: Record<string, unknown> }).value
  }
  const file = (path: string) => mock.api.data.files.readText(path).catch(() => null)
  return { mock, off, store, run, execute, file }
}

describe('clock commands refuse no-ops and undo exactly', () => {
  it('refuses Pomodoro start, pause and reset that would not change it and restores its saved bytes on undo', async () => {
    const { mock, off, store, run, execute, file } = setup()
    try {
      await store.ready
      await expect(run('pomodoro-pause')).rejects.toMatchObject(unavailable)
      await expect(run('pomodoro-reset')).rejects.toMatchObject(unavailable)
      expect(mock.busUndo).toHaveLength(0)

      await execute('pomodoro-start')
      await tick()
      await execute('pomodoro-pause')
      const paused = await file('pomodoro.json')
      const undoCount = mock.busUndo.length
      await expect(run('pomodoro-pause')).rejects.toMatchObject(unavailable)
      expect(await file('pomodoro.json')).toBe(paused)

      await execute('pomodoro-start')
      const running = await file('pomodoro.json')
      await expect(run('pomodoro-start')).rejects.toMatchObject(unavailable)
      expect(await file('pomodoro.json')).toBe(running)
      expect(mock.busUndo).toHaveLength(undoCount + 1)
      await tick()
      await mock.busUndo.at(-1)!.undo()
      expect(await file('pomodoro.json')).toBe(paused)
      expect(store.state.pomo.running).toBe(false)
      expect(mock.scheduledNotifications.has('pomodoro')).toBe(false)

      await execute('pomodoro-start')
      const restarted = await file('pomodoro.json')
      await tick()
      await execute('pomodoro-pause')
      await tick()
      await mock.busUndo.at(-1)!.undo()
      expect(await file('pomodoro.json')).toBe(restarted)
      expect(store.state.pomo.running).toBe(true)

      await execute('pomodoro-pause')
      await execute('pomodoro-skip')
      const skipped = await file('pomodoro.json')
      await expect(mock.busUndo.at(-1)!.undo()).rejects.toMatchObject(conflict)
      expect(await file('pomodoro.json')).toBe(skipped)
    } finally { off() }
  })

  it('refuses a world move or add that changes nothing and restores the exact list and saved value on undo', async () => {
    const { mock, off, store, run, execute } = setup({ worldCities: ['Asia/Tokyo'] })
    try {
      await store.ready
      await execute('world-add', { city: 'London' })
      const london = store.state.worldCities[1]
      expect(store.state.worldCities).toEqual(['Asia/Tokyo', london])
      await mock.busUndo.at(-1)!.undo()
      expect(mock.api.settings.get().worldCities).toEqual(['Asia/Tokyo'])
      expect(store.state.worldCities).toEqual(['Asia/Tokyo'])

      await execute('world-add', { city: 'London' })
      await execute('world-add', { city: 'Sydney' })
      const saved = structuredClone(mock.api.settings.get().worldCities)
      const undoCount = mock.busUndo.length
      await expect(run('world-add', { query: 'Tokyo' })).rejects.toMatchObject(unavailable)
      await expect(run('world-move', { query: 'Tokyo', position: 1 })).rejects.toMatchObject(unavailable)
      await expect(run('world-move', { query: 'Sydney', position: 9 })).rejects.toMatchObject(unavailable)
      await expect(run('world-remove', { query: 'Atlantis' })).rejects.toMatchObject(unavailable)
      await store.flush()
      expect(mock.api.settings.get().worldCities).toEqual(saved)
      expect(mock.busUndo).toHaveLength(undoCount)

      await execute('world-remove', { city: 'Tokyo' })
      await mock.busUndo.at(-1)!.undo()
      expect(mock.api.settings.get().worldCities).toEqual(saved)

      await execute('world-move', { city: 'Sydney', position: 1 })
      store.worldMove(1, 2)
      await store.flush()
      const changed = structuredClone(mock.api.settings.get().worldCities)
      await expect(mock.busUndo.at(-1)!.undo()).rejects.toMatchObject(conflict)
      expect(mock.api.settings.get().worldCities).toEqual(changed)
    } finally { off() }
  })

  it('refuses cancelling a missing timer and undoes a start only while the timer is unchanged', async () => {
    const { mock, off, store, run, execute, file } = setup()
    try {
      await store.ready
      await expect(run('timer-cancel')).rejects.toMatchObject(unavailable)
      const first = await execute('timer-start', { duration: '5m', label: 'Tea' })
      const before = await file('timers.jsonl')
      await expect(run('timer-cancel', { id: 'missing' })).rejects.toMatchObject(unavailable)
      await execute('timer-start', { duration: '10m' })
      await mock.busUndo.at(-1)!.undo()
      expect(await file('timers.jsonl')).toBe(before)
      expect(store.state.timers.map(timer => timer.id)).toEqual([first.id])

      await execute('timer-start', { duration: '10m' })
      const second = store.state.timers.at(-1)!.id
      store.pauseTimer(second)
      await store.flush()
      const paused = await file('timers.jsonl')
      await expect(mock.busUndo.at(-1)!.undo()).rejects.toMatchObject(conflict)
      expect(await file('timers.jsonl')).toBe(paused)
    } finally { off() }
  })

  it('restores a removed or toggled alarm at its place with every saved field', async () => {
    const { mock, off, store, execute, file } = setup()
    try {
      await store.ready
      const first = await execute('alarm-add', { time: '07:00', label: 'First', days: 'mon,wed' })
      await execute('alarm-add', { time: '08:00', label: 'Second' })
      const saved = await file('alarms.jsonl')

      await execute('alarm-remove', { id: first.id })
      await mock.busUndo.at(-1)!.undo()
      expect(await file('alarms.jsonl')).toBe(saved)
      expect(store.state.alarms.map(alarm => alarm.label)).toEqual(['First', 'Second'])

      await execute('alarm-toggle', { id: first.id })
      expect(await file('alarms.jsonl')).not.toBe(saved)
      await mock.busUndo.at(-1)!.undo()
      expect(await file('alarms.jsonl')).toBe(saved)

      await execute('alarm-add', { time: '09:00', label: 'Third' })
      await mock.busUndo.at(-1)!.undo()
      expect(await file('alarms.jsonl')).toBe(saved)
      await expect(mock.busUndo.at(-1)!.undo()).rejects.toMatchObject(conflict)
      expect(await file('alarms.jsonl')).toBe(saved)
    } finally { off() }
  })

  it('refuses switching to the current tab or display and resetting a reset stopwatch', async () => {
    const { mock, off, store, run } = setup()
    try {
      await store.ready
      await expect(run('mode', { mode: store.state.mode })).rejects.toMatchObject(unavailable)
      await expect(run('display', { surface: 'stopwatch', style: 'analog' })).rejects.toMatchObject(unavailable)
      await expect(run('sw-reset')).rejects.toMatchObject(unavailable)
      expect(mock.busUndo).toHaveLength(0)
      expect(await mock.api.data.files.readText('stopwatch.json').catch(() => null)).toBeNull()
    } finally { off() }
  })
})
