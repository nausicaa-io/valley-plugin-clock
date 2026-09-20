import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'

export function createFormatterCache(capacity = 256) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) throw new RangeError('Invalid formatter cache capacity')
  const entries = new Map<string, Intl.DateTimeFormat>()
  return {
    get size(): number { return entries.size },
    get(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
      const key = JSON.stringify([Intl.getCanonicalLocales(locale), Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))])
      let formatter = entries.get(key)
      if (formatter) entries.delete(key)
      else formatter = new Intl.DateTimeFormat(locale, options)
      entries.set(key, formatter)
      if (entries.size > capacity) entries.delete(entries.keys().next().value!)
      return formatter
    }
  }
}

const formatters = createFormatterCache()

// ---- Famous cities (curated; IANA time zones) ------------------------------
export interface City {
  id?: string
  name: string
  tz: string
  aliases?: string[]
}
export const CITIES: City[] = [
  { name: 'Honolulu', tz: 'Pacific/Honolulu' },
  { name: 'Anchorage', tz: 'America/Anchorage' },
  { name: 'Los Angeles', tz: 'America/Los_Angeles' },
  { id: 'America/Los_Angeles#San_Francisco', name: 'San Francisco', tz: 'America/Los_Angeles' },
  { id: 'America/Los_Angeles#Seattle', name: 'Seattle', tz: 'America/Los_Angeles' },
  { name: 'Vancouver', tz: 'America/Vancouver' },
  { name: 'Calgary', tz: 'America/Edmonton' },
  { name: 'Denver', tz: 'America/Denver' },
  { name: 'Phoenix', tz: 'America/Phoenix' },
  { name: 'Chicago', tz: 'America/Chicago' },
  { id: 'America/Chicago#Dallas', name: 'Dallas', tz: 'America/Chicago' },
  { name: 'New York', tz: 'America/New_York' },
  { id: 'America/New_York#Boston', name: 'Boston', tz: 'America/New_York' },
  { id: 'America/New_York#Miami', name: 'Miami', tz: 'America/New_York' },
  { id: 'America/New_York#Washington_DC', name: 'Washington, D.C.', tz: 'America/New_York', aliases: ['Washington DC'] },
  { name: 'Toronto', tz: 'America/Toronto' },
  { id: 'America/Toronto#Montreal', name: 'Montréal', tz: 'America/Toronto', aliases: ['Montreal'] },
  { name: 'Mexico City', tz: 'America/Mexico_City' },
  { id: 'America/Mexico_City#Guadalajara', name: 'Guadalajara', tz: 'America/Mexico_City' },
  { name: 'Havana', tz: 'America/Havana' },
  { name: 'Panama City', tz: 'America/Panama' },
  { name: 'San José', tz: 'America/Costa_Rica', aliases: ['San Jose'] },
  { name: 'San Juan', tz: 'America/Puerto_Rico' },
  { name: 'Bogotá', tz: 'America/Bogota', aliases: ['Bogota'] },
  { name: 'Lima', tz: 'America/Lima' },
  { name: 'Caracas', tz: 'America/Caracas' },
  { name: 'Santiago', tz: 'America/Santiago' },
  { name: 'São Paulo', tz: 'America/Sao_Paulo' },
  { id: 'America/Sao_Paulo#Rio_de_Janeiro', name: 'Rio de Janeiro', tz: 'America/Sao_Paulo' },
  { name: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires' },
  { name: 'Reykjavík', tz: 'Atlantic/Reykjavik', aliases: ['Reykjavik'] },
  { name: 'London', tz: 'Europe/London' },
  { name: 'Dublin', tz: 'Europe/Dublin' },
  { name: 'Lisbon', tz: 'Europe/Lisbon' },
  { name: 'Madrid', tz: 'Europe/Madrid' },
  { name: 'Paris', tz: 'Europe/Paris' },
  { name: 'Amsterdam', tz: 'Europe/Amsterdam' },
  { name: 'Brussels', tz: 'Europe/Brussels' },
  { id: 'Europe/Zurich#Bern', name: 'Bern', tz: 'Europe/Zurich', aliases: ['Berne'] },
  { name: 'Zürich', tz: 'Europe/Zurich', aliases: ['Zurich', 'Zuerich'] },
  { id: 'Europe/Zurich#Geneva', name: 'Geneva', tz: 'Europe/Zurich', aliases: ['Genève', 'Geneve'] },
  { name: 'Berlin', tz: 'Europe/Berlin' },
  { name: 'Copenhagen', tz: 'Europe/Copenhagen' },
  { name: 'Oslo', tz: 'Europe/Oslo' },
  { name: 'Stockholm', tz: 'Europe/Stockholm' },
  { name: 'Prague', tz: 'Europe/Prague' },
  { name: 'Budapest', tz: 'Europe/Budapest' },
  { name: 'Vienna', tz: 'Europe/Vienna' },
  { name: 'Warsaw', tz: 'Europe/Warsaw' },
  { name: 'Kyiv', tz: 'Europe/Kyiv', aliases: ['Kiev'] },
  { name: 'Rome', tz: 'Europe/Rome' },
  { name: 'Athens', tz: 'Europe/Athens' },
  { name: 'Bucharest', tz: 'Europe/Bucharest' },
  { name: 'Helsinki', tz: 'Europe/Helsinki' },
  { name: 'Istanbul', tz: 'Europe/Istanbul' },
  { name: 'Moscow', tz: 'Europe/Moscow' },
  { name: 'Casablanca', tz: 'Africa/Casablanca' },
  { name: 'Lagos', tz: 'Africa/Lagos' },
  { name: 'Accra', tz: 'Africa/Accra' },
  { name: 'Cairo', tz: 'Africa/Cairo' },
  { name: 'Johannesburg', tz: 'Africa/Johannesburg' },
  { id: 'Africa/Johannesburg#Cape_Town', name: 'Cape Town', tz: 'Africa/Johannesburg' },
  { name: 'Nairobi', tz: 'Africa/Nairobi' },
  { name: 'Addis Ababa', tz: 'Africa/Addis_Ababa' },
  { name: 'Jerusalem', tz: 'Asia/Jerusalem' },
  { id: 'Asia/Jerusalem#Tel_Aviv', name: 'Tel Aviv', tz: 'Asia/Jerusalem' },
  { name: 'Riyadh', tz: 'Asia/Riyadh' },
  { name: 'Dubai', tz: 'Asia/Dubai' },
  { id: 'Asia/Dubai#Abu_Dhabi', name: 'Abu Dhabi', tz: 'Asia/Dubai' },
  { name: 'Doha', tz: 'Asia/Qatar' },
  { name: 'Muscat', tz: 'Asia/Muscat' },
  { name: 'Tehran', tz: 'Asia/Tehran' },
  { name: 'Baku', tz: 'Asia/Baku' },
  { name: 'Tbilisi', tz: 'Asia/Tbilisi' },
  { name: 'Tashkent', tz: 'Asia/Tashkent' },
  { name: 'Almaty', tz: 'Asia/Almaty' },
  { name: 'Karachi', tz: 'Asia/Karachi' },
  { name: 'Mumbai', tz: 'Asia/Kolkata' },
  { id: 'Asia/Kolkata#New_Delhi', name: 'New Delhi', tz: 'Asia/Kolkata', aliases: ['Delhi'] },
  { id: 'Asia/Kolkata#Bengaluru', name: 'Bengaluru', tz: 'Asia/Kolkata', aliases: ['Bangalore'] },
  { name: 'Colombo', tz: 'Asia/Colombo' },
  { name: 'Kathmandu', tz: 'Asia/Kathmandu' },
  { name: 'Dhaka', tz: 'Asia/Dhaka' },
  { name: 'Bangkok', tz: 'Asia/Bangkok' },
  { name: 'Jakarta', tz: 'Asia/Jakarta' },
  { name: 'Kuala Lumpur', tz: 'Asia/Kuala_Lumpur' },
  { name: 'Ho Chi Minh City', tz: 'Asia/Ho_Chi_Minh', aliases: ['Saigon'] },
  { name: 'Singapore', tz: 'Asia/Singapore' },
  { name: 'Manila', tz: 'Asia/Manila' },
  { name: 'Hong Kong', tz: 'Asia/Hong_Kong' },
  { name: 'Shanghai', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Beijing', name: 'Beijing', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Shenzhen', name: 'Shenzhen', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Guangzhou', name: 'Guangzhou', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Chengdu', name: 'Chengdu', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Hangzhou', name: 'Hangzhou', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Wuhan', name: 'Wuhan', tz: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai#Chongqing', name: 'Chongqing', tz: 'Asia/Shanghai' },
  { name: 'Macao', tz: 'Asia/Macau', aliases: ['Macau'] },
  { name: 'Taipei', tz: 'Asia/Taipei' },
  { id: 'Asia/Taipei#Kaohsiung', name: 'Kaohsiung', tz: 'Asia/Taipei' },
  { name: 'Tokyo', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Osaka', name: 'Osaka', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Kyoto', name: 'Kyoto', tz: 'Asia/Tokyo' },
  { id: 'Asia/Tokyo#Nagoya', name: 'Nagoya', tz: 'Asia/Tokyo' },
  { name: 'Seoul', tz: 'Asia/Seoul' },
  { id: 'Asia/Seoul#Busan', name: 'Busan', tz: 'Asia/Seoul' },
  { name: 'Perth', tz: 'Australia/Perth' },
  { name: 'Adelaide', tz: 'Australia/Adelaide' },
  { name: 'Brisbane', tz: 'Australia/Brisbane' },
  { name: 'Sydney', tz: 'Australia/Sydney' },
  { name: 'Melbourne', tz: 'Australia/Melbourne' },
  { name: 'Auckland', tz: 'Pacific/Auckland' },
  { id: 'Pacific/Auckland#Wellington', name: 'Wellington', tz: 'Pacific/Auckland' },
  { name: 'Suva', tz: 'Pacific/Fiji' },
  { name: 'Nouméa', tz: 'Pacific/Noumea', aliases: ['Noumea'] },
  { name: 'Guam', tz: 'Pacific/Guam' }
]
export const cityId = (city: City): string => city.id ?? city.tz
export const cityFor = (id: string): City | undefined => CITIES.find((city) => cityId(city) === id) ?? CITIES.find((city) => city.tz === id)
export const cityZone = (id: string): string => cityFor(id)?.tz ?? id
export const normalizeCityTerm = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export const cityMatches = (city: City, query: string): boolean => {
  const q = normalizeCityTerm(query.trim())
  return q !== '' && [city.name, city.tz, ...(city.aliases ?? [])].some((value) => normalizeCityTerm(value).includes(q))
}
export const cityName = (id: string): string => cityFor(id)?.name ?? id.split('/').pop()!.replace(/_/g, ' ')

/** Local wall-clock time in `tz` (24h), optionally with seconds. */
export function cityTime(tz: string, date: Date, seconds = false, locale = 'en-GB'): string {
  try {
    return formatters.get(locale, {
      timeZone: cityZone(tz),
      hour: '2-digit',
      minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}),
      hour12: false
    }).format(date)
  } catch {
    return '--:--'
  }
}

/** Local hour (0–23) in `tz`, or -1 when the zone is invalid. */
export function cityHour(tz: string, date: Date): number {
  try {
    const h = formatters.get('en-GB', { timeZone: cityZone(tz), hour: '2-digit', hour12: false }).format(date)
    const n = parseInt(h, 10)
    return Number.isFinite(n) ? n % 24 : -1
  } catch {
    return -1
  }
}

/** Apple-Clock-style day/night flag: daytime is the 07:00–18:59 window in `tz`.
 *  A coarse fixed threshold (not true sunrise/sunset) — enough to tint a row
 *  light by day and dark at night. Invalid zones default to daytime. */
export function isDaytime(tz: string, date: Date): boolean {
  const h = cityHour(tz, date)
  if (h < 0) return true
  return h >= 7 && h < 19
}

const dateParts = (date: Date, zone: string): Record<string, number> => Object.fromEntries(formatters.get('en-GB', {
  timeZone: cityZone(zone), year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))

export function dayOffset(tz: string, date: Date, localZone?: string): number {
  const day = (zone?: string): number => {
    if (!zone) return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    const parts = dateParts(date, zone)
    return Date.UTC(parts.year, parts.month - 1, parts.day)
  }
  return Math.round((day(tz) - day(localZone)) / 86_400_000)
}

export function dayOffsetLabel(tz: string, date: Date): string {
  try {
    const diff = dayOffset(tz, date)
    if (!Number.isFinite(diff)) return ''
    if (diff === 0) return uiText('auto.24345a14377f')
    if (diff === 1) return uiText('auto.1948bf2dfa8f')
    if (diff === -1) return uiText('auto.da24830f1f70')
    return diff > 0 ? uiText('auto.f36f7ec0d246', { p0: diff }) : uiText('auto.d9dd4edbc100', { p0: diff })
  } catch {
    return ''
  }
}

export function offsetLabel(tz: string, date: Date, localZone?: string): string {
  const minutes = (zone?: string): number => {
    if (!zone) return date.getHours() * 60 + date.getMinutes()
    const parts = formatters.get('en-GB', { timeZone: cityZone(zone), hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
    return Number(parts.find(part => part.type === 'hour')?.value) % 24 * 60 + Number(parts.find(part => part.type === 'minute')?.value)
  }
  try {
    let diff = minutes(tz) - minutes(localZone)
    if (!Number.isFinite(diff)) return ''
    if (diff > 720) diff -= 1440
    if (diff < -720) diff += 1440
    if (diff === 0) return ''
    const sign = diff > 0 ? '+' : '−'
    const abs = Math.abs(diff)
    const hrs = Math.floor(abs / 60)
    const mins = abs % 60
    return `${sign}${hrs}${mins ? `:${String(mins).padStart(2, '0')}` : ''} h`
  } catch {
    return ''
  }
}

export function findCity(query: string): City | null {
  const q = query.trim()
  if (!q) return null
  return CITIES.find(city => cityId(city).toLowerCase() === q.toLowerCase()) ??
    CITIES.find(city => normalizeCityTerm(city.name) === normalizeCityTerm(q)) ??
    CITIES.find(city => cityMatches(city, q)) ?? null
}

interface WorldClockPorts {
  api(): Pick<ValleyPluginApi, 'settings'>
  enqueue(write: () => Promise<unknown>): void
  notify(): void
  persistenceError(): Error
}

export function createWorldClock(ports: WorldClockPorts) {
  let items: string[] = []
  const persist = (): void => {
    const api = ports.api()
    const value = JSON.stringify(items)
    ports.enqueue(async () => { if (!(await api.settings.set('worldCities', value)).ok) throw ports.persistenceError() })
    ports.notify()
  }
  return {
    get items(): string[] { return items },
    restore(saved: readonly string[]): void { items = [...saved] },
    add(query: string): City | null {
      const city = findCity(query)
      if (!city || items.includes(cityId(city))) return city
      items.push(cityId(city))
      persist()
      return city
    },
    remove(id: string): boolean {
      const next = items.filter(city => city !== id)
      if (next.length === items.length) return false
      items = next
      persist()
      return true
    },
    move(from: number, to: number): boolean {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false
      const next = [...items]
      next.splice(to, 0, next.splice(from, 1)[0])
      if (next.every((id, index) => id === items[index])) return false
      items = next
      persist()
      return true
    }
  }
}
