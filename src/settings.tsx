import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { uiText } from './localization'
import type { ClockStore } from './store'
import type { PomoConfig, PomodoroProfile } from './pomodoro'
import { SOUND_IDS, SOUND_LABEL } from './sounds'
import { VIEW_SETTING, TIMER_PRESET_LIMIT, timerPresets, fmtPresetLabel, type ClockView } from './preferences'
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

    const { Row, Toggle, SelectField, NumberField, ChipsField, TextField, Button } = api.ui.settings
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
          SOUND_IDS.map((id) => ({ value: id, label: SOUND_LABEL[id]() })),
          'beep'
        ),
        numberRow(uiText('auto.d913b34a7c13'), 'alarmSnooze', 9)
      )
    }
    if (sec === 'stopwatch') {
      return h('div', { style: { width: '100%' } }, displayRow(uiText('auto.0be9b9c95c84'), uiText('auto.e6e7c33b16bd'), 'stopwatchDisplay'))
    }
    if (sec === 'timer') {
      // Settings configures the tab, it does not run it: the adder and the
      // live list belong to the panel, and duplicating them here only gave the
      // user a second, half-featured Timer. What is left is the one thing the
      // panel cannot offer — which quick durations its chip row holds.
      const presets = timerPresets(s)
      const title = uiText('auto.79c10c38e47a')
      return h(
        'div',
        { style: { width: '100%' } },
        row(
          title,
          uiText('auto.e5fb71d3a486', { p0: TIMER_PRESET_LIMIT }),
          h(ChipsField, {
            items: presets,
            ariaLabel: title,
            placeholder: '10m',
            reorderable: true,
            // A parseable draft becomes its canonical label ("90s" → "1m30s")
            // so the chip and the panel's button read the same; anything else
            // survives verbatim for `validate` to reject with a reason.
            normalize: (value: string) => fmtPresetLabel(parseDuration(value)) || value.trim(),
            validate: (value: string, items: readonly string[]) => {
              if (parseDuration(value) <= 0) return uiText('auto.f55f1dcb0b3d')
              // Never disable the field at the limit — that would grey out the
              // chips' own remove buttons and strand the user at five.
              if (items.length >= TIMER_PRESET_LIMIT) return uiText('auto.efb57a5f4f04', { p0: TIMER_PRESET_LIMIT })
              return true
            },
            onChange: (items: string[]) => set('timerPresets', JSON.stringify(items.slice(0, TIMER_PRESET_LIMIT)))
          })
        )
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
      displayRow(uiText('auto.0bb80737096b'), uiText('auto.28ec48330176'), 'clockDisplay'),
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
