import type { PluginBackendApi } from '@valley/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, mockPreviewPlayback } from './harness'
import { register, soundWav } from '../src/backend'
import { createSoundPlayer } from '../src/sounds'
import { isSoundId, SOUND_IDS } from '../src/soundLibrary'

const backend = () => {
  const files = new Map<string, string>([['beep.wav', 'custom bytes']])
  const handlers = new Map<string, (payload?: unknown) => unknown>()
  const storage = {
    open: vi.fn(async () => ({ handle: 'sounds', path: '' })),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async ({ path }) => files.has(path) ? { kind: 'file' } : null),
    writeBytes: vi.fn(async ({ path }, value) => { files.set(path, value) }),
    list: vi.fn(async () => [...files.keys()].map(name => ({ name, kind: 'file' }))),
    readBytes: vi.fn(async ({ path }, options) => ({ base64: files.get(path), nextOffset: options.offset + 3, done: true })),
    reveal: vi.fn(async () => {}), close: vi.fn(async () => {})
  }
  const mock = createMockValleyApi({ manifest: { id: 'clock' } })
  const dispose = register({ ...mock.backendApi, storage, rpc: { ...mock.backendApi.rpc, handleOperation: () => () => {}, handle: (method: string, handler: (payload?: unknown) => unknown) => {
    handlers.set(method, handler); return () => { handlers.delete(method) }
  } } } as unknown as PluginBackendApi)
  return { files, storage, dispose, call: async (method: string, payload?: unknown) => handlers.get(method)!(payload) }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('alarm sound folder', () => {
  it('seeds valid WAVs, preserves replacements, and discovers added songs without restarting', async () => {
    const h = backend()
    await h.call('sounds.list')
    expect(h.files.get('beep.wav')).toBe('custom bytes')
    expect(h.storage.writeBytes).toHaveBeenCalledTimes(4)
    for (const id of SOUND_IDS) {
      const bytes = Buffer.from(soundWav(id), 'base64')
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8)
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44)
    }
    h.files.set('Forest song.mp3', 'abc')
    h.files.set('ignore.txt', 'text')
    expect(await h.call('sounds.list')).toContainEqual({ value: 'file:Forest song.mp3', label: 'Forest song' })
    expect(await h.call('sounds.list')).not.toContainEqual(expect.objectContaining({ value: 'file:ignore.txt' }))
    await h.call('sounds.read', { id: 'file:Forest song.mp3', offset: 0 })
    expect(h.storage.readBytes).toHaveBeenCalledWith({ handle: 'sounds', path: 'Forest song.mp3' }, { offset: 0, maxBytes: 192 * 1024 })
    await h.dispose()
    expect(h.storage.close).toHaveBeenCalledWith('sounds')
  })

  it('rejects traversal and invalid offsets before reading', async () => {
    const h = backend()
    for (const id of ['file:../sound.wav', 'file:/sound.wav', 'file:sound.exe', 'file:dir\\sound.wav']) {
      expect(isSoundId(id)).toBe(false)
      await expect(h.call('sounds.read', { id, offset: 0 })).rejects.toThrow()
    }
    await expect(h.call('sounds.read', { id: 'beep', offset: -1 })).rejects.toThrow()
    expect(h.storage.readBytes).not.toHaveBeenCalled()
    await h.dispose()
  })

  it('cancels an in-flight preview and delegates its local file, pause, resume and disposal to the host', async () => {
    const mock = createMockValleyApi()
    const preview = mockPreviewPlayback(mock.api)
    let resolve!: (value: unknown) => void
    vi.mocked(mock.api.backend.call).mockImplementation(() => new Promise(done => { resolve = done }))
    const player = createSoundPlayer(() => mock.api)
    const cancelled = player.play('file:Forest.mp3')!
    cancelled.stop()
    resolve([])
    await Promise.resolve(); await Promise.resolve()
    expect(preview.createLocalPlayer).not.toHaveBeenCalled()
    const playback = player.play('file:Forest.mp3')!
    playback.pause()
    resolve([])
    await vi.waitFor(() => expect(preview.players[0]?.load).toHaveBeenCalledOnce())
    expect(preview.createLocalPlayer).toHaveBeenCalledWith(expect.objectContaining({ preview: true }))
    expect(preview.players[0].load).toHaveBeenCalledWith(expect.objectContaining({ path: '.valley/assets/alarm-sounds/Forest.mp3' }), { autoplay: false, position: 0 })
    expect(preview.players[0].play).not.toHaveBeenCalled()
    playback.resume()
    expect(preview.players[0].play).toHaveBeenCalledOnce()
    player.stopAll()
    expect(preview.players[0].dispose).toHaveBeenCalledOnce()
  })

  it('ends a preview exactly once and never synthesizes fallback audio', async () => {
    const mock = createMockValleyApi()
    const preview = mockPreviewPlayback(mock.api)
    const done = vi.fn()
    const player = createSoundPlayer(() => mock.api)
    player.play('beep', done)
    await vi.waitFor(() => expect(preview.players[0]?.play).toHaveBeenCalledOnce())
    preview.players[0].emit('ended')
    preview.players[0].emit('ended')
    expect(done).toHaveBeenCalledOnce()
    expect(preview.players[0].dispose).toHaveBeenCalledOnce()
    expect(createSoundPlayer().play('beep')).toBeNull()
  })
})
