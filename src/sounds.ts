import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { CONFIG_DIR } from '@valley/plugin-sdk/paths'
import { uiText } from './localization'
import { SOUND_FOLDER, isSoundId, type AlarmSoundId, type BuiltinSoundId } from './soundLibrary'
export { SOUNDS, SOUND_IDS } from './soundLibrary'
export type { AlarmSoundId } from './soundLibrary'

export interface SoundPlayback {
  readonly continuous?: boolean
  pause: () => void
  resume: () => void
  stop: () => void
}

type PreviewPlayer = Awaited<ReturnType<ValleyPluginApi['playback']['createLocalPlayer']>>

function playFile(api: ValleyPluginApi, id: AlarmSoundId, onDone: () => void): SoundPlayback {
  let stopped = false
  let paused = false
  let ready = false
  let player: PreviewPlayer | null = null
  let off: (() => void) | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    off?.()
    void player?.dispose().catch(() => {})
  }
  const finish = (): void => { if (stopped) return; stop(); onDone() }
  const run = (action: (value: PreviewPlayer) => Promise<{ status: string }>): void => {
    if (stopped || !ready || !player) return
    void action(player).then(receipt => { if (receipt.status !== 'observed') finish() }).catch(finish)
  }
  void (async () => {
    await api.backend.call('sounds.list')
    if (stopped) return
    const value = await api.playback.createLocalPlayer({ id: `sound-preview:${crypto.randomUUID()}`, preview: true })
    player = value
    if (stopped) { await value.dispose(); return }
    off = value.onChange(snapshot => { if (snapshot.state.status === 'ended' || snapshot.state.status === 'error') finish() })
    const name = id.startsWith('file:') ? id.slice(5) : `${id}.wav`
    const path = `${CONFIG_DIR}/${SOUND_FOLDER}/${name}`
    await value.load({ key: `preview:${id}`, providerId: 'clock', sourceId: id, path, kind: 'audio', title: name.replace(/\.[^.]+$/, ''), artists: [], feat: [] }, { autoplay: false, position: 0 })
    if (stopped) return
    ready = true
    if (!paused) run(current => current.play())
  })().catch(finish)
  return {
    get continuous() { return !stopped },
    stop,
    pause: () => { paused = true; run(value => value.pause()) },
    resume: () => { paused = false; run(value => value.play()) }
  }
}

export function createSoundPlayer(api?: () => ValleyPluginApi | undefined) {
  const active = new Set<SoundPlayback>()
  return {
    play(id: AlarmSoundId = 'beep', onDone?: () => void): SoundPlayback | null {
      const source = api?.()
      if (!source || !isSoundId(id)) return null
      let playback: SoundPlayback
      const done = (): void => { active.delete(playback); onDone?.() }
      const sound = playFile(source, id, done)
      playback = { get continuous() { return sound.continuous }, pause: sound.pause, resume: sound.resume,
        stop: () => { active.delete(playback); sound.stop() } }
      active.add(playback)
      return playback
    },
    stopAll(): void { for (const sound of active) sound.stop() }
  }
}

export const SOUND_LABEL: Record<BuiltinSoundId, () => string> = {
  beep: () => uiText('auto.1973db095880'),
  chime: () => uiText('auto.3bb8c51f1c3b'),
  pulse: () => uiText('auto.b3cc660b9187'),
  radar: () => uiText('auto.aad82db2cb77'),
  bell: () => uiText('auto.d4198662a72f')
}
