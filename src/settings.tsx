import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import type { ClockStore } from './store'
import type { PomoConfig, PomodoroProfile } from './pomodoro'
import { VIEW_SETTING, timerPresetEntries, fmtPresetLabel, type ClockView } from './preferences'
import { parseDuration } from './timers'
import { setIconDragImage, dropDestination, type DragLike } from './reorder'

type ViewNode = ReturnType<ValleyPluginApi['React']['createElement']>
interface ClockSettingsRenderers {
  worldAddSelect(): ViewNode
  worldList(drag: boolean): ViewNode
  pomodoroIcon(): ViewNode
}

export function createClockSettings(api: ValleyPluginApi, store: ClockStore, { worldAddSelect, worldList, pomodoroIcon }: ClockSettingsRenderers) {
  const React = api.React
  const h = React.createElement
  // ---- Settings view (5 sub-sections) ------------------------------------
  // Rendered inside the core Settings modal (`<section class="settings-section">`),
  // so it reuses the shared settings row/switch CSS for a native look. The active
  // sub-section arrives as the `section` prop (see manifest `settingsSections`).
  const SettingsView = ({ section }: { section?: string }): ReturnType<typeof h> => {
    const sec = section || 'clock'
    const [, force] = React.useState(0)
    const splitDuration = (seconds: number) => ({ h: String(Math.floor(seconds / 3600)).padStart(2, '0'), m: String(Math.floor(seconds % 3600 / 60)).padStart(2, '0'), s: String(seconds % 60).padStart(2, '0') })
    const [presetRows, setPresetRows] = React.useState(() => timerPresetEntries(api.settings.get()).map(({ duration: saved, name }, id) => ({ id, name, saved: saved as string | null, ...splitDuration(parseDuration(saved)), error: '' })))
    const nextPresetId = React.useRef(presetRows.length)
    const presetList = React.useRef<HTMLDivElement>(null)
    const [soundError, setSoundError] = React.useState('')
    const [pomoDetail, setPomoDetail] = React.useState<string | null>(() =>
      sec === 'pomodoro' ? store.state.pomoSettingsProfileId : null
    )
    React.useEffect(() => {
      const rerender = (): void => force((n) => n + 1)
      const off = store.subscribe(rerender)
      const offSettings = api.settings.subscribe(rerender)
      // Only the World list shows live times — tick just for it.
      const iv = sec === 'world' ? window.setInterval(rerender, 1000) : 0
      return () => {
        off()
        offSettings()
        if (iv) window.clearInterval(iv)
      }
    }, [sec])
    React.useEffect(() => {
      if (sec !== 'pomodoro') {
        setPomoDetail(null)
        return
      }
      if (store.state.pomoSettingsProfileId) {
        setPomoDetail(store.state.pomoSettingsProfileId)
        store.state.pomoSettingsProfileId = null
      }
    }, [sec])
    React.useEffect(() => {
      if (sec !== 'alarm') return
      void store.refreshSounds()
      const interval = window.setInterval(() => { void store.refreshSounds() }, 3000)
      return () => window.clearInterval(interval)
    }, [sec])
    const s = api.settings.get()
    const set = (key: string, value: unknown): void => {
      const pomoKeys: Record<string, keyof PomoConfig> = {
        pomodoroWork: 'work',
        pomodoroShort: 'short',
        pomodoroLong: 'long',
        pomodoroCycles: 'cycles'
      }
      const pomoKey = pomoKeys[key]
      if (sec === 'pomodoro' && pomoKey && typeof value === 'number') {
        store.updatePomoProfile(store.state.pomoProfileId, { [pomoKey]: value })
        return
      }
      void api.settings.set(key, value)
    }

    const { Row, Toggle, SelectField, NumberField, TextField, Button } = api.ui.settings
    const row = (label: string, desc: string | undefined, control: ReturnType<typeof h>): ReturnType<typeof h> =>
      h(Row, { title: label, ...(desc ? { description: desc } : {}) }, control)
    const switchEl = (on: boolean, onChange: (v: boolean) => void, label: string): ReturnType<typeof h> =>
      h(Toggle, { checked: on, onChange, label })
    const toggleRow = (label: string, desc: string, key: string): ReturnType<typeof h> => {
      // All clock toggles default on, so absence reads as enabled.
      const on = s[key] !== false
      return row(label, desc, switchEl(on, (v) => set(key, v), label))
    }
    const displayRow = (label: string, desc: string, key: string): ReturnType<typeof h> => {
      const value = s[key] === 'digital' ? 'digital' : 'analog'
      return row(
        label,
        desc,
        h(SelectField, {
          value,
          ariaLabel: label,
          onChange: (next: string) => set(key, next),
          options: [
            { value: 'analog', label: uiText('auto.830bf70f56c5') },
            { value: 'digital', label: uiText('auto.bbe5befacfed') }
          ]
        })
      )
    }
    const selectRow = (
      label: string,
      desc: string | undefined,
      key: string,
      options: { value: string; label: string }[],
      dflt: string
    ): ReturnType<typeof h> =>
      row(
        label,
        desc,
        h(SelectField, {
          value: typeof s[key] === 'string' ? String(s[key]) : dflt,
          ariaLabel: label,
          onChange: (next: string) => set(key, next),
          options
        })
      )
    const numberRow = (label: string, key: string, dflt: number): ReturnType<typeof h> =>
      row(
        label,
        undefined,
        h(NumberField, {
          min: 1,
          value: Number(s[key]) > 0 ? Number(s[key]) : dflt,
          allowEmpty: true,
          ariaLabel: label,
          onChange: (next: number | null) => set(key, next ?? undefined)
        })
      )

    if (sec === 'world') {
      return h(
        'div',
        { className: 'clock-world-settings', style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' } },
        h(
          'span',
          { className: 'settings-empty-text', style: { marginBottom: '2px' } },
          uiText('auto.3fde460125d8')
        ),
        worldAddSelect(),
        worldList(true)
      )
    }

    if (sec === 'alarm') {
      return h(
        'div',
        { style: { width: '100%' } },
        selectRow(
          uiText('auto.816c0ceb45b0'),
          uiText('auto.2193e49f6961'),
          'alarmSound',
          store.soundOptions(),
          'beep'
        ),
        row(uiText('sounds.folder'), uiText('sounds.folderDescription'), h(Button, {
          onClick: () => { void api.backend.call('sounds.reveal').catch(() => setSoundError(uiText('sounds.unavailable'))) }
        }, uiText('sounds.openFolder'))),
        soundError && h('div', { role: 'alert' }, soundError),
        numberRow(uiText('auto.d913b34a7c13'), 'alarmSnooze', 9)
      )
    }
    if (sec === 'stopwatch') {
      return h('div', { style: { width: '100%' } }, displayRow(uiText('auto.0be9b9c95c84'), uiText('auto.e6e7c33b16bd'), 'stopwatchDisplay'))
    }
    if (sec === 'timer') {
      const persist = (rows: typeof presetRows): void => {
        setPresetRows(rows)
        set('timerPresets', JSON.stringify(rows.flatMap(row => row.saved ? [row.name.trim() ? { duration: row.saved, name: row.name.trim() } : row.saved] : [])))
      }
      const commit = (id: number, pastedSeconds?: number): void => {
        const row = presetRows.find(row => row.id === id)
        if (!row) return
        const valid = [row.h, row.m, row.s].every(value => /^\d*$/.test(value)) && Number(row.m) < 60 && Number(row.s) < 60
        const seconds = pastedSeconds ?? (valid ? Number(row.h) * 3600 + Number(row.m) * 60 + Number(row.s) : 0)
        const saved = fmtPresetLabel(seconds)
        const error = !Number.isSafeInteger(seconds) || seconds <= 0 || seconds >= 1000 * 3600 ? uiText('timer.invalidDuration')
          : presetRows.some(other => other.id !== id && other.saved === saved) ? uiText('timer.duplicate') : ''
        const next = presetRows.map(row => row.id === id ? error ? { ...row, error } : { ...row, saved, ...splitDuration(seconds), error: '' } : row)
        if (error) setPresetRows(next)
        else persist(next)
      }
      return h('div', { className: 'clock-preset-settings' },
        h('h4', { className: 'settings-label' }, uiText('timer.presets')),
        h('div', { className: 'clock-preset-list', ref: presetList },
          h('div', { className: 'clock-preset-units', 'aria-hidden': true },
            ...(['h', 'm', 's'] as const).map(unit => h('span', { key: unit }, uiText(`timer.shortUnit.${unit}`)))
          ),
          ...presetRows.map((row, index) => h('div', { key: row.id, className: 'clock-preset-entry' },
            h('div', { className: 'clock-preset-line' },
              h('input', {
                className: 'clock-preset-name settings-control', type: 'text', maxLength: 40, value: row.name,
                placeholder: uiText('timer.optionalName'),
                'aria-label': uiText('timer.nameForPreset', { number: index + 1 }),
                onChange: (event: { target: { value: string } }) => setPresetRows(rows => rows.map(item => item.id === row.id ? { ...item, name: event.target.value } : item)),
                onBlur: () => { if (row.saved) persist(presetRows) },
                onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLInputElement }) => {
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                }
              }),
              h('div', {
                className: 'clock-preset-time', role: 'group', 'aria-label': uiText('timer.presetNumber', { number: index + 1 }),
                onBlur: (event: { currentTarget: HTMLElement; relatedTarget: Node | null }) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) commit(row.id)
                },
                onPaste: (event: { clipboardData: { getData(type: string): string }; preventDefault(): void }) => {
                  const value = event.clipboardData.getData('text')
                  if (!/[a-z:]/i.test(value)) return
                  const seconds = parseDuration(value)
                  if (seconds > 0) { event.preventDefault(); commit(row.id, seconds) }
                }
              },
                h('div', { className: 'clock-preset-digits', 'data-invalid': !!row.error },
                  ...(['h', 'm', 's'] as const).flatMap((unit, unitIndex) => [
                    ...(unitIndex ? [h('span', { key: `${unit}-colon`, className: 'clock-preset-colon', 'aria-hidden': true }, ':')] : []),
                    h('input', {
                      key: unit, type: 'text', inputMode: 'numeric', maxLength: unit === 'h' ? 3 : 2, value: row[unit],
                      'aria-label': uiText('timer.unitForPreset', { unit: uiText(`timer.unit.${unit}`), number: index + 1 }),
                      'aria-invalid': !!row.error,
                      onFocus: (event: { currentTarget: HTMLInputElement }) => event.currentTarget.select(),
                      onChange: (event: { target: { value: string } }) => {
                        const value = event.target.value
                        if (/^\d*$/.test(value)) setPresetRows(rows => rows.map(item => item.id === row.id ? { ...item, [unit]: value, error: '' } : item))
                      },
                      onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void; currentTarget: HTMLInputElement }) => {
                        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                        if (event.key === 'Escape') {
                          event.preventDefault(); event.stopPropagation()
                          setPresetRows(rows => rows.map(item => item.id === row.id ? { ...item, ...splitDuration(parseDuration(item.saved ?? '')), error: '' } : item))
                        }
                      }
                    })
                  ])
                )
              ),
              h('button', {
                type: 'button', className: 'clock-preset-remove',
                'aria-label': uiText('timer.removeNumber', { number: index + 1 }),
                onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
                onClick: () => persist(presetRows.filter(item => item.id !== row.id))
              }, '×'),
              row.error && h('div', { className: 'clock-preset-error', role: 'alert' }, row.error)
            )
          ))
        ),
        h('button', {
          type: 'button', className: 'clock-preset-add', 'aria-label': uiText('timer.addPreset'), title: uiText('timer.addPreset'),
          onClick: () => {
            setPresetRows(rows => [...rows, { id: nextPresetId.current++, saved: null, name: '', ...splitDuration(0), error: '' }])
            window.requestAnimationFrame(() => presetList.current?.querySelector<HTMLInputElement>('.clock-preset-entry:last-child input')?.focus())
          }
        }, '+')
      )
    }
    if (sec === 'pomodoro') {
      const profiles = store.pomoProfiles()
      const selected = profiles.find((profile) => profile.id === pomoDetail)
      const profileName = (profile: PomodoroProfile): string => profile.name || uiText('auto.fe7f55b8bf68')
      const profileSummary = (profile: PomodoroProfile): string => uiText('surface.pomodoroSummary', {
        work: profile.work,
        short: profile.short,
        long: profile.long,
        cycles: profile.cycles
      })
      if (selected) {
        const profileNumberRow = (label: string, key: keyof PomoConfig): ReturnType<typeof h> =>
          row(
            label,
            undefined,
            h(NumberField, {
              min: 1,
              value: selected[key],
              allowEmpty: true,
              ariaLabel: label,
              onChange: (value: number | null) => {
                if (value !== null) store.updatePomoProfile(selected.id, { [key]: value })
              }
            })
          )
        return h(
          'div',
          { className: 'settings-section settings-listpage clock-pomodoro-settings' },
          h(
            'div',
            { className: 'settings-listpage-crumbs' },
            h(
              'button',
              {
                type: 'button',
                className: 'settings-listpage-back',
                'aria-label': uiText('auto.77dfd2135f4d'),
                onClick: () => setPomoDetail(null)
              },
              '‹'
            ),
            h('span', { className: 'settings-list-name' }, profileName(selected))
          ),
          row(
            uiText('auto.709a23220f2c'),
            undefined,
            h(TextField, {
              value: selected.name,
              placeholder: uiText('auto.fe7f55b8bf68'),
              ariaLabel: uiText('auto.709a23220f2c'),
              onChange: (value: string) => store.renamePomoProfile(selected.id, value),
              onCommit: (value: string) => store.renamePomoProfile(selected.id, value, true)
            })
          ),
          profileNumberRow(uiText('auto.2b3d1c34c35f'), 'work'),
          profileNumberRow(uiText('auto.26d345c90583'), 'short'),
          profileNumberRow(uiText('auto.abed5549bdb9'), 'long'),
          profileNumberRow(uiText('auto.5075a58d4e4a'), 'cycles'),
          profiles.length > 1 && h(
            'div',
            { className: 'settings-row-actions' },
            h(
              Button,
              {
                className: 'settings-button settings-button--danger',
                onClick: () => {
                  store.removePomoProfile(selected.id)
                  setPomoDetail(null)
                }
              },
              uiText('surface.pomodoroRemove')
            )
          )
        )
      }
      return h(
        'div',
        { className: 'settings-section settings-listpage clock-pomodoro-settings' },
        h(
          'div',
          { className: 'settings-listpage-header' },
          h('h4', { className: 'settings-label' }, uiText('auto.212e4618d030')),
          h(
            Button,
            {
              className: 'settings-listpage-add settings-button settings-button--small',
              'aria-label': uiText('surface.pomodoroAdd'),
              title: uiText('surface.pomodoroAdd'),
              onClick: () => store.addPomoProfile()
            },
            '+'
          )
        ),
        h(
          'div',
          { className: 'settings-list' },
          ...profiles.map((profile, index) => {
            const dragging = store.state.pomoProfileDrag === index
            const drop = store.state.pomoProfileDrop?.index === index ? store.state.pomoProfileDrop : null
            return h(
              'button',
              {
                key: profile.id,
                type: 'button',
                draggable: true,
                className: 'settings-list-row',
                'data-reorder-active': dragging ? 'true' : undefined,
                'data-drop-position': drop ? (drop.after ? 'after' : 'before') : undefined,
                onClick: () => {
                  store.selectPomoProfile(profile.id)
                  setPomoDetail(profile.id)
                },
                onDragStart: (e: DragLike) => {
                  store.state.pomoProfileDrag = index
                  store.state.pomoProfileDrop = null
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                  setIconDragImage(e.currentTarget?.querySelector('.settings-list-glyph svg'), e.dataTransfer)
                  store.notify()
                },
                onDragOver: (e: DragLike) => {
                  e.preventDefault()
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget?.getBoundingClientRect()
                  const after = rect && e.clientY != null ? e.clientY > rect.top + rect.height / 2 : false
                  const current = store.state.pomoProfileDrop
                  if (!current || current.index !== index || current.after !== after) {
                    store.state.pomoProfileDrop = { index, after }
                    store.notify()
                  }
                },
                onDrop: (e: DragLike) => {
                  e.preventDefault()
                  const from = store.state.pomoProfileDrag
                  const after = store.state.pomoProfileDrop?.after ?? false
                  if (from != null && from !== index) store.pomoProfileMove(from, dropDestination(from, index, after))
                  store.state.pomoProfileDrag = null
                  store.state.pomoProfileDrop = null
                  store.notify()
                },
                onDragEnd: () => {
                  store.state.pomoProfileDrag = null
                  store.state.pomoProfileDrop = null
                  store.notify()
                }
              },
              h('span', { className: 'settings-list-glyph', 'aria-hidden': true }, pomodoroIcon()),
              h(
                'span',
                { className: 'settings-list-meta' },
                h('span', { className: 'settings-list-name' }, profileName(profile)),
                h('span', { className: 'settings-list-sub' }, profileSummary(profile))
              ),
              h('span', { className: 'settings-list-chevron', 'aria-hidden': true }, '›')
            )
          })
        )
      )
    }
    // Default: Clock — the plugin's root page, which also carries the five
    // view switches (the shape Assistant uses for Telegram / WhatsApp).
    const VIEW_ROWS: [ClockView, string, string][] = [
      ['world', uiText('auto.6a968a7094fe'), uiText('auto.2a8a7da69f8f')],
      ['alarm', uiText('auto.25f8c55de811'), uiText('auto.a0fd69ac917c')],
      ['stopwatch', uiText('auto.15bd6cc6511c'), uiText('auto.d8127bcecbf4')],
      ['timer', uiText('auto.9d9cec22f36f'), uiText('auto.e2b64297512f')],
      ['pomodoro', uiText('auto.212e4618d030'), uiText('auto.5b9be3e4f35a')]
    ]
    return h(
      'div',
      { style: { width: '100%' } },
      toggleRow(uiText('auto.f7172f2029ed'), uiText('auto.e4608fde30c3'), 'seconds'),
      h('h4', { key: 'views', className: 'settings-label clock-settings-label' }, uiText('auto.3286a93a040f')),
      ...VIEW_ROWS.map(([view, label, desc]) => {
        const key = VIEW_SETTING[view]
        return h(
          Row,
          { key: view, title: label, description: desc },
          switchEl(s[key] !== false, (v: boolean) => set(key, v), label)
        )
      })
    )
  }

  return SettingsView
}
