import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { register, type ClockStore } from '../src/index'
import manifest from '../manifest.json'
import config from '../config.json'

const disposers: Array<() => void> = []
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach(dispose => dispose()); vi.useRealTimers(); vi.restoreAllMocks() })
const makeMock = () => createMockValleyApi({ manifest: { ...manifest, ...config } as unknown as ValleyPluginManifest })

describe('Clock settings and registration ownership', () => {
  it('preserves Settings component state while notifying and owns only the current section interval', async () => {
    vi.useFakeTimers()
    const mock = makeMock()
    const subscriptions = new Set<() => void>()
    const subscribe = mock.api.settings.subscribe
    vi.spyOn(mock.api.settings, 'subscribe').mockImplementation(listener => {
      subscriptions.add(listener)
      const off = subscribe(listener)
      return () => { subscriptions.delete(listener); off() }
    })
    const interval = vi.spyOn(window, 'setInterval')
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const dispose = register(mock.api)
    disposers.push(dispose)
    const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
    await store.ready
    const registrations = vi.mocked(mock.api.registerView).mock.calls
    const Settings = registrations.find(([id]) => id === 'clock.settings')![1] as React.ComponentType<{ section?: string }>
    const mounted = render(<Settings section="world" />)
    const search = screen.getByLabelText('Search cities…') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Tok' } })
    expect(search.value).toBe('Tok')
    expect(subscriptions.size).toBe(2)
    expect(interval).toHaveBeenCalledOnce()
    await act(async () => { store.notify(); await mock.api.settings.set('seconds', false) })
    expect(screen.getByLabelText('Search cities…')).toBe(search)
    expect(search.value).toBe('Tok')
    expect(vi.mocked(mock.api.registerView)).toHaveBeenCalledTimes(2)
    expect(interval).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(search.value).toBe('Tok')
    mounted.rerender(<Settings section="clock" />)
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(subscriptions.size).toBe(2)
    mounted.unmount()
    expect(subscriptions.size).toBe(1)
    dispose()
    expect(subscriptions.size).toBe(0)
  })

  it('keeps command persistence and teardown attached to the registering injected API', async () => {
    const mock = makeMock()
    const dispose = register(mock.api)
    disposers.push(dispose)
    const store = mock.api.runtime.getOrCreate<ClockStore>('clock.store', () => { throw new Error('Missing Clock store') })
    await store.ready
    expect(mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)).toHaveLength(1)
    await mock.api.commands.execute('clock:sw-start', {})
    expect(await mock.api.data.dataset('stopwatch_state').get({ id: 'stopwatch' })).toMatchObject({ running: true })
    const profiles = store.pomoProfiles()
    await mock.api.commands.execute('clock:pomodoro-start', {})
    expect(store.pomoProfiles()).toBe(profiles)
    expect(await mock.api.data.dataset('pomodoro_state').get({ id: 'pomodoro' })).toMatchObject({ phase: 'work', running: true })
    dispose()
    expect(mock.api.commands.list()).toEqual([])
    expect(mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)).toEqual([])
    expect(document.getElementById('notes-clock-styles')).toBeNull()
    const flush = vi.spyOn(store, 'flush')
    const notify = vi.spyOn(store, 'syncSettings')
    await mock.runBeforeUnload()
    await mock.api.settings.set('seconds', false)
    expect(flush).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
