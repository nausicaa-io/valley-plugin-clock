import { registerClockWorkflow } from './workflow'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { SOUNDS, SOUND_IDS, SOUND_FOLDER, isSoundFile, isSoundId, type BuiltinSoundId } from '../soundLibrary'

export function soundWav(id: BuiltinSoundId): string {
  const spec = SOUNDS[id]
  const rate = 22050
  const length = Math.ceil(spec.repeat * (spec.steps.reduce((sum, [, duration]) => sum + duration, 0) + spec.gap) * rate)
  const bytes = new Uint8Array(44 + length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, length * 2, true)
  let elapsed = 0
  for (let repeat = 0; repeat < spec.repeat; repeat++) {
    for (const [frequency, duration] of spec.steps) {
      for (let i = 0; i < Math.floor(duration * rate); i++) {
        const t = i / rate
        const phase = t * frequency % 1
        const sample = spec.type === 'square' ? (phase < 0.5 ? 1 : -1) : spec.type === 'sawtooth' ? 2 * phase - 1 : spec.type === 'triangle' ? 1 - 4 * Math.abs(phase - 0.5) : Math.sin(2 * Math.PI * phase)
        const envelope = Math.min(1, t / 0.02) * Math.exp(-8 * t / duration)
        const gain = spec.type === 'square' || spec.type === 'sawtooth' ? 0.18 : 0.3
        view.setInt16(44 + (Math.floor(elapsed * rate) + i) * 2, Math.round(sample * envelope * gain * 32767), true)
      }
      elapsed += duration
    }
    elapsed += spec.gap
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

export function register(api: PluginBackendApi): () => Promise<void> {
  const offWorkflow = registerClockWorkflow(api)
  let folder: Promise<{ handle: string; path: string }> | undefined
  const open = () => folder ??= (async () => {
    const grant = await api.storage.open({ area: 'metadata', path: SOUND_FOLDER, kind: 'directory', mode: 'write' })
    const root = { handle: grant.handle, path: '' }
    try {
      await api.storage.mkdir(root)
      for (const id of SOUND_IDS) {
        const location = { ...root, path: `${id}.wav` }
        if (!(await api.storage.stat(location))) await api.storage.writeBytes(location, soundWav(id))
      }
      return root
    } catch (error) { await api.storage.close(grant.handle); throw error }
  })().catch(error => { folder = undefined; throw error })
  void open().catch(() => undefined)
  const offs = [
    api.rpc.handle('sounds.list', async () => {
      const root = await open()
      return (await api.storage.list(root)).filter(entry => entry.kind === 'file' && isSoundFile(entry.name)).map(entry => ({
        value: SOUND_IDS.some(id => `${id}.wav` === entry.name) ? entry.name.slice(0, -4) : `file:${entry.name}`,
        label: entry.name.replace(/\.[^.]+$/, '')
      })).sort((a, b) => a.label.localeCompare(b.label))
    }),
    api.rpc.handle('sounds.read', async (payload) => {
      const { id, offset } = (payload ?? {}) as { id?: unknown; offset?: unknown }
      if (!isSoundId(id) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 128 * 1024 * 1024) throw new Error('Invalid sound request')
      const root = await open()
      return api.storage.readBytes({ ...root, path: id.startsWith('file:') ? id.slice(5) : `${id}.wav` }, { offset, maxBytes: 192 * 1024 })
    }),
    api.rpc.handle('sounds.reveal', async () => { await api.storage.reveal(await open()) })
  ]
  return async () => { await offWorkflow(); offs.forEach(off => off()); const root = await folder?.catch(() => undefined); if (root) await api.storage.close(root.handle) }
}
