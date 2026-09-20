import { uiText } from './localization'
/** Built-in synthesised alarm tones — no audio assets, so nothing to bundle. */
export type AlarmSoundId = 'beep' | 'chime' | 'pulse' | 'radar' | 'bell'

// ---- Audible alarms --------------------------------------------------------
// Tones are synthesised on the fly (WebAudio) rather than shipped as assets:
// `api.vault.readFile` is UTF-8 only, so a bundled sound file would need new
// SDK surface. `beep` is the historical timer/Pomodoro tone — keep it default.
interface SoundSpec {
  type: OscillatorType
  /** `[frequency Hz, duration s]` played back to back inside one repetition. */
  steps: [number, number][]
  repeat: number
  /** Silence between repetitions, in seconds. */
  gap: number
}
export const SOUNDS: Record<AlarmSoundId, SoundSpec> = {
  beep: { type: 'sine', steps: [[880, 0.3]], repeat: 4, gap: 0.42 },
  chime: {
    type: 'sine',
    steps: [
      [523, 0.35],
      [659, 0.35],
      [784, 0.5]
    ],
    repeat: 2,
    gap: 0.1
  },
  pulse: { type: 'square', steps: [[440, 0.12]], repeat: 8, gap: 0.18 },
  radar: {
    type: 'sawtooth',
    steps: [
      [600, 0.2],
      [900, 0.2]
    ],
    repeat: 3,
    gap: 0.25
  },
  bell: { type: 'triangle', steps: [[1046, 0.9]], repeat: 2, gap: 0.9 }
}
export const SOUND_IDS = Object.keys(SOUNDS) as AlarmSoundId[]

export interface SoundPlayback {
  pause: () => void
  resume: () => void
  stop: () => void
}

function playSound(id: AlarmSoundId = 'beep', onDone?: () => void): SoundPlayback | null {
  const spec = Object.hasOwn(SOUNDS, id) ? SOUNDS[id] : SOUNDS.beep
  let opened: AudioContext | undefined
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    opened = ctx
    // A square/sawtooth at the same gain reads much louder than a sine — trim
    // the harsher waveforms so no preset jumps out against the others.
    const peak = spec.type === 'sine' || spec.type === 'triangle' ? 0.3 : 0.18
    let t = ctx.currentTime
    const oscillators: OscillatorNode[] = []
    for (let r = 0; r < spec.repeat; r += 1) {
      for (const [freq, dur] of spec.steps) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = spec.type
        o.frequency.value = freq
        o.connect(g)
        g.connect(ctx.destination)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(peak, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, dur - 0.02))
        o.start(t)
        o.stop(t + dur)
        oscillators.push(o)
        t += dur
      }
      t += spec.gap
    }
    const totalMs = (t - ctx.currentTime) * 1000 + 200
    let closeTimer: number | null = null
    let remainingMs = totalMs
    let startedAt = Date.now()
    let paused = false
    let closed = false
    const finish = (notify: boolean): void => {
      if (closed) return
      closed = true
      if (closeTimer != null) window.clearTimeout(closeTimer)
      void Promise.resolve(ctx.close()).catch(() => {})
      if (notify) onDone?.()
    }
    const scheduleClose = (delay: number): void => {
      closeTimer = window.setTimeout(() => finish(true), delay)
    }
    scheduleClose(totalMs)
    return {
      pause: () => {
        if (closed || paused) return
        paused = true
        remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt))
        if (closeTimer != null) window.clearTimeout(closeTimer)
        closeTimer = null
        void Promise.resolve(ctx.suspend()).catch(() => {})
      },
      resume: () => {
        if (closed || !paused) return
        paused = false
        startedAt = Date.now()
        void Promise.resolve(ctx.resume()).catch(() => {})
        scheduleClose(remainingMs)
      },
      stop: () => {
        if (closed) return
        for (const oscillator of oscillators) {
          try { oscillator.stop() } catch { /* already stopped */ }
        }
        finish(false)
      }
    }
  } catch {
    if (opened) void Promise.resolve(opened.close()).catch(() => {})
    /* audio unavailable — fail silently */
    return null
  }
}

export function createSoundPlayer() {
  const active = new Set<SoundPlayback>()
  return {
    play(id: AlarmSoundId = 'beep', onDone?: () => void): SoundPlayback | null {
      let playback: SoundPlayback | null = null
      const sound = playSound(id, () => { if (playback) active.delete(playback); onDone?.() })
      if (!sound) return null
      playback = { pause: sound.pause, resume: sound.resume, stop: () => { if (playback) active.delete(playback); sound.stop() } }
      active.add(playback)
      return playback
    },
    stopAll(): void { for (const sound of active) sound.stop() }
  }
}

export const SOUND_LABEL: Record<AlarmSoundId, () => string> = {
  beep: () => uiText('auto.1973db095880'),
  chime: () => uiText('auto.3bb8c51f1c3b'),
  pulse: () => uiText('auto.b3cc660b9187'),
  radar: () => uiText('auto.aad82db2cb77'),
  bell: () => uiText('auto.d4198662a72f')
}
