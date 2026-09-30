import type { ValleyPluginApi } from '@valley/plugin-sdk'

type ClockDataApi = Pick<ValleyPluginApi, 'data'>
type ClockFile = 'alarms.jsonl' | 'timers.jsonl' | 'stopwatch.json' | 'pomodoro.json'

function parse<T>(path: ClockFile, content: string): T {
  const object = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Clock data in ${path}`)
    return value
  }
  return (path.endsWith('.jsonl')
    ? content.split(/\r?\n/).filter(line => line.trim()).map(line => object(JSON.parse(line)))
    : object(JSON.parse(content))) as T
}

export async function readClockFile<T>(api: ClockDataApi, path: ClockFile): Promise<T | null> {
  const content = await api.data.files.readText(path)
  return content === null ? null : parse<T>(path, content)
}

export async function writeClockFile(api: ClockDataApi, path: ClockFile, value: unknown): Promise<void> {
  const content = path.endsWith('.jsonl')
    ? (value as unknown[]).map(record => `${JSON.stringify(record)}\n`).join('')
    : `${JSON.stringify(value, null, 2)}\n`
  const existing = await api.data.files.readTextBaseline(path)
  if (existing) parse(path, existing.content)
  const result = await api.data.files.writeTextGuarded(path, content, existing?.baseline ?? null)
  if (!result.ok) throw new Error(`Could not save Clock data in ${path}: ${result.reason}`)
}
