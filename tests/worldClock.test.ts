import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { cityHour, cityTime, createFormatterCache, createWorldClock, dayOffset, dayOffsetLabel, findCity, isDaytime, offsetLabel } from '../src/worldClock'
import { initLocalization } from '../src/localization'

afterEach(() => { vi.restoreAllMocks() })

describe('world clock owner', () => {
  it.each([
    ['2026-03-29T00:59:00Z', '01:59', 1],
    ['2026-03-29T01:00:00Z', '03:00', 3],
    ['2026-10-25T00:59:00Z', '02:59', 2],
    ['2026-10-25T01:00:00Z', '02:00', 2]
  ])('uses the timezone offset at %s across DST transitions', (iso, time, hour) => {
    const date = new Date(iso)
    expect(cityTime('Europe/Zurich#Bern', date)).toBe(time)
    expect(cityHour('Europe/Zurich', date)).toBe(hour)
  })

  it('compares calendar days across month/year boundaries and the date line', () => {
    expect(dayOffset('Asia/Tokyo', new Date('2025-12-31T16:00:00Z'), 'UTC')).toBe(1)
    expect(dayOffset('America/Los_Angeles', new Date('2026-03-01T01:00:00Z'), 'UTC')).toBe(-1)
    expect(dayOffset('Pacific/Kiritimati', new Date('2026-01-01T10:30:00Z'), 'Pacific/Pago_Pago')).toBe(2)
    expect(dayOffset('Pacific/Pago_Pago', new Date('2026-01-01T10:30:00Z'), 'Pacific/Kiritimati')).toBe(-2)
    expect(dayOffset('Europe/Zurich', new Date('2026-03-29T22:30:00Z'), 'UTC')).toBe(1)
  })

  it('retains the relative-offset convention, half/quarter-hour zones and independent DST changes', () => {
    expect(offsetLabel('Asia/Kathmandu', new Date('2026-01-01T00:30:00Z'), 'UTC')).toBe('+5:45 h')
    expect(offsetLabel('Australia/Adelaide', new Date('2026-01-01T00:30:00Z'), 'UTC')).toBe('+10:30 h')
    expect(offsetLabel('Pacific/Auckland', new Date('2026-01-01T00:30:00Z'), 'UTC')).toBe('−11 h')
    expect(offsetLabel('Europe/Zurich', new Date('2026-03-10T12:00:00Z'), 'America/New_York')).toBe('+5 h')
    expect(offsetLabel('Europe/Zurich', new Date('2026-03-30T12:00:00Z'), 'America/New_York')).toBe('+6 h')
    expect(offsetLabel('Europe/Zurich#Bern', new Date('2026-03-30T12:00:00Z'), 'Europe/Zurich')).toBe('')
  })

  it('keeps day/night thresholds and invalid-input fallbacks', () => {
    expect(isDaytime('Asia/Tokyo', new Date('2026-01-01T21:59:00Z'))).toBe(false)
    expect(isDaytime('Asia/Tokyo', new Date('2026-01-01T22:00:00Z'))).toBe(true)
    expect(isDaytime('Asia/Tokyo', new Date('2026-01-01T10:00:00Z'))).toBe(false)
    for (const date of [new Date(), new Date(NaN)]) {
      expect(cityTime('Invalid/Zone', date)).toBe('--:--')
      expect(cityHour('Invalid/Zone', date)).toBe(-1)
      expect(isDaytime('Invalid/Zone', date)).toBe(true)
      expect(dayOffsetLabel('Invalid/Zone', date)).toBe('')
      expect(offsetLabel('Invalid/Zone', date)).toBe('')
    }
    expect(dayOffsetLabel('UTC', new Date(NaN))).toBe('')
  })

  it('formats with the current locale and translates day labels at call time', () => {
    const date = new Date('2026-01-01T05:06:07Z')
    for (const locale of ['en-GB', 'de-CH', 'ar-EG', 'zh-CN', 'en-GB']) {
      expect(cityTime('Asia/Tokyo', date, true, locale)).toBe(new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date))
    }
    const { api } = createMockValleyApi({ manifest: { id: 'clock' } })
    let language = 'en'
    vi.spyOn(api.ui, 't').mockImplementation(key => `${language}:${key}`)
    initLocalization(api)
    const local = new Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(dayOffsetLabel(local, date)).toBe('en:auto.24345a14377f')
    language = 'de'
    expect(dayOffsetLabel(local, date)).toBe('de:auto.24345a14377f')
  })

  it('reuses canonical locale/options combinations and evicts the least recently used formatter', () => {
    const cache = createFormatterCache(2)
    const first = cache.get('en-gb', { timeZone: 'UTC', hour: '2-digit' })
    expect(cache.get('en-GB', { hour: '2-digit', timeZone: 'UTC', second: undefined })).toBe(first)
    const other = cache.get('de-CH', { timeZone: 'UTC', hour: '2-digit' })
    expect(other).not.toBe(first)
    expect(cache.get('en-GB', { timeZone: 'UTC', hour: '2-digit' })).toBe(first)
    cache.get('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit' })
    expect(cache.size).toBe(2)
    expect(cache.get('en-GB', { timeZone: 'UTC', hour: '2-digit' })).toBe(first)
    expect(cache.get('de-CH', { timeZone: 'UTC', hour: '2-digit' })).not.toBe(other)
    expect(() => cache.get('en-GB', { timeZone: 'Invalid/Zone' })).toThrow()
    expect(cache.size).toBe(2)
    expect(() => createFormatterCache(257)).toThrow()
  })

  it('constructs no further formatters for repeated world rows or shared-zone city IDs', async () => {
    vi.resetModules()
    const world = await import('../src/worldClock')
    const constructor = Intl.DateTimeFormat
    const builds = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((locale, options) => new constructor(locale, options))
    const render = (date: Date): void => {
      world.cityTime('Europe/Zurich#Bern', date, false, 'de-CH')
      world.cityTime('Europe/Zurich', date, false, 'de-CH')
      world.isDaytime('Europe/Zurich', date)
      world.dayOffsetLabel('Europe/Zurich', date)
      world.offsetLabel('Europe/Zurich', date)
    }
    render(new Date('2026-03-29T00:59:00Z'))
    expect(builds).toHaveBeenCalledTimes(4)
    for (let tick = 0; tick < 60; tick++) render(new Date(Date.parse('2026-03-29T01:00:00Z') + tick * 1000))
    expect(builds).toHaveBeenCalledTimes(4)
    world.cityTime('Europe/Zurich', new Date(), true, 'de-CH')
    world.cityTime('Europe/Zurich', new Date(), false, 'en-GB')
    expect(builds).toHaveBeenCalledTimes(5)
  })

  it('matches canonical IDs, accents and aliases while retaining distinct same-zone cities', () => {
    expect(findCity(' Bern ')?.id).toBe('Europe/Zurich#Bern')
    expect(findCity('Zuerich')?.name).toBe('Zürich')
    expect(findCity('geneve')?.name).toBe('Geneva')
    expect(findCity('San Francisco')?.id).toBe('America/Los_Angeles#San_Francisco')
    expect(findCity('EUROPE/ZURICH')?.name).toBe('Zürich')
    expect(findCity('')).toBeNull()
    expect(findCity('unknown city')).toBeNull()
  })

  it('owns ordered selection and queues captured snapshots against the originating API', async () => {
    const first = createMockValleyApi({ manifest: { id: 'clock' } })
    const second = createMockValleyApi({ manifest: { id: 'clock' } })
    let api = first.api
    const writes: Array<() => Promise<unknown>> = []
    const notify = vi.fn()
    const world = createWorldClock({ api: () => api, enqueue: write => { writes.push(write) }, notify, persistenceError: () => new Error('Rejected') })
    world.add('Bern')
    world.add('Zuerich')
    world.add('Bern')
    expect(world.items).toEqual(['Europe/Zurich#Bern', 'Europe/Zurich'])
    expect(writes).toHaveLength(2)
    expect(world.move(0, 1)).toBe(true)
    expect(world.move(1, 1)).toBe(false)
    expect(world.move(0, 0.5)).toBe(false)
    api = second.api
    expect(world.remove('Europe/Zurich#Bern')).toBe(true)
    expect(world.remove('missing')).toBe(false)
    for (const write of writes) await write()
    expect(first.api.settings.get().worldCities).toBe('["Europe/Zurich","Europe/Zurich#Bern"]')
    expect(second.api.settings.get().worldCities).toBe('["Europe/Zurich"]')
    expect(notify).toHaveBeenCalledTimes(4)
    const restored = ['Europe/Zurich#Bern', 'Unknown/Zone']
    world.restore(restored)
    restored.push('Asia/Tokyo')
    expect(world.items).toEqual(['Europe/Zurich#Bern', 'Unknown/Zone'])
    expect(writes).toHaveLength(4)
    world.restore(['Europe/Zurich', 'Europe/Zurich'])
    expect(world.move(0, 1)).toBe(false)
    expect(writes).toHaveLength(4)
  })
})
