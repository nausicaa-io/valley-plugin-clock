export type BuiltinSoundId = 'beep' | 'chime' | 'pulse' | 'radar' | 'bell'
export type AlarmSoundId = BuiltinSoundId | `file:${string}`
export const SOUND_FOLDER = 'assets/alarm-sounds'
export interface SoundOption { value: AlarmSoundId; label: string }
export const isSoundFile = (name: string): boolean => !/[\\/\x00-\x1f]/.test(name) && /\.(wav|mp3|m4a|aac|ogg|opus|flac|webm)$/i.test(name)
export const isSoundId = (id: unknown): id is AlarmSoundId => typeof id === 'string' && (Object.hasOwn(SOUNDS, id) || (id.startsWith('file:') && isSoundFile(id.slice(5))))

interface SoundSpec {
  type: OscillatorType
  /** `[frequency Hz, duration s]` played back to back inside one repetition. */
  steps: [number, number][]
  repeat: number
  /** Silence between repetitions, in seconds. */
  gap: number
}
export const SOUNDS: Record<BuiltinSoundId, SoundSpec> = {
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
export const SOUND_IDS = Object.keys(SOUNDS) as BuiltinSoundId[]

