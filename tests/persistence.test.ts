import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './harness'
import { readClockFile, writeClockFile } from '../src/persistence'
import { register, type ClockStore } from '../src/index'
import config from '../config.json'

const mock = () => createMockValleyApi({ manifest: { id: 'clock' } })

describe('Clock file persistence', () => {
  it('stores ordered UTF-8 records as complete JSONL snapshots, including an empty list', async () => {
    const { api } = mock()
    const records = [{ id: 'second', label: 'Frühstück\nGröße', days: [1, 3] }, { id: 'first', label: '茶', days: [] }]
    await writeClockFile(api, 'alarms.jsonl', records)
    const text = (await api.data.files.readText('alarms.jsonl'))!
    expect(text.split('\n')).toHaveLength(3)
    expect(text.trim().split('\n').map(line => JSON.parse(line))).toEqual(records)
    expect(await readClockFile(api, 'alarms.jsonl')).toEqual(records)
    await writeClockFile(api, 'alarms.jsonl', [])
    expect(await api.data.files.readText('alarms.jsonl')).toBe('')
    expect(await readClockFile(api, 'alarms.jsonl')).toEqual([])
  })

  it('keeps stopwatch state and laps together in one JSON snapshot', async () => {
    const { api } = mock()
    expect(await readClockFile(api, 'stopwatch.json')).toBeNull()
    const state = { running: true, startedAt: 1234, elapsed: 456, laps: [250, 100] }
    await writeClockFile(api, 'stopwatch.json', state)
    expect(JSON.parse((await api.data.files.readText('stopwatch.json'))!)).toEqual(state)
  })

  it.each(['{"id":"saved"}\n{broken', 'null\n', '[]\n'])('rejects corrupt JSONL without replacing its contents: %s', async content => {
    const { api } = mock()
    await api.data.files.writeTextGuarded('alarms.jsonl', content, null)
    await expect(readClockFile(api, 'alarms.jsonl')).rejects.toThrow()
    await expect(writeClockFile(api, 'alarms.jsonl', [])).rejects.toThrow()
    expect(await api.data.files.readText('alarms.jsonl')).toBe(content)
  })

  it('reports a concurrent file change and preserves the newer disk contents', async () => {
    const { api } = mock()
    const write = api.data.files.writeTextGuarded
    vi.spyOn(api.data.files, 'writeTextGuarded').mockImplementationOnce(async (path, content, baseline) => {
      await write(path, '{"id":"external"}\n', null)
      return write(path, content, baseline)
    })
    await expect(writeClockFile(api, 'timers.jsonl', [])).rejects.toThrow('conflict')
    expect(await readClockFile(api, 'timers.jsonl')).toEqual([{ id: 'external' }])
  })

  it('surfaces write failures through flush and runs every Clock owner without SQL access', async () => {
    const h = mock()
    const dataset = vi.spyOn(h.api.data, 'dataset').mockImplementation(() => { throw new Error('SQL must not be used') })
    const transaction = vi.spyOn(h.api.data, 'transaction').mockImplementation(() => { throw new Error('SQL must not be used') })
    expect(config).not.toHaveProperty('datasets')
    expect(config).not.toHaveProperty('datasetMigrations')
    const dispose = register(h.api)
    const store = h.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing store') })
    try {
      await store.ready
      store.addAlarm({ hour: 8, days: [1] })
      store.addTimer(60)
      store.swStart()
      store.swLap()
      store.pomoStart()
      await store.flush()
      expect(dataset).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
      vi.spyOn(h.api.data.files, 'writeTextGuarded').mockRejectedValueOnce(new Error('Disk unavailable'))
      store.addTimer(120)
      await expect(store.flush()).rejects.toThrow('Disk unavailable')
    } finally { dispose(); vi.restoreAllMocks() }
  })
})
