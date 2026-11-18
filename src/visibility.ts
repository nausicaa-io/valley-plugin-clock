/**
 * Reports whether `element` is shown: its window is visible and the element is laid out on screen. A Clock panel can stay
 * mounted in a sidebar tab or behind another pane while its window is in front; `document.hidden` alone then keeps polls
 * and re-renders running for a frame nobody sees (GODS G6). Without IntersectionObserver (tests) only the window counts.
 */
export function observeShown(element: Element | null | undefined, onChange: (shown: boolean) => void): () => void {
  const view = element?.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? undefined : window)
  const doc = element?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document)
  let onScreen = true
  let last: boolean | undefined
  const report = (): void => {
    const shown = !doc?.hidden && onScreen
    if (shown !== last) { last = shown; onChange(shown) }
  }
  let observer: IntersectionObserver | undefined
  const Observer = (view as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | undefined)?.IntersectionObserver
  if (element && Observer) {
    observer = new Observer(entries => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      onScreen = entry.isIntersecting
      report()
    })
    observer.observe(element)
  }
  doc?.addEventListener('visibilitychange', report)
  report()
  return () => { observer?.disconnect(); doc?.removeEventListener('visibilitychange', report) }
}

/** Runs `tick` every `intervalMs` while shown (see `observeShown`); nothing stays armed otherwise. */
export function whileVisible(tick: () => void, intervalMs: number, element?: Element | null): () => void {
  let timer = 0
  const view = element?.ownerDocument?.defaultView ?? window
  const stop = observeShown(element, shown => {
    if (!shown) { if (timer) view.clearInterval(timer); timer = 0 }
    else if (!timer) timer = view.setInterval(tick, intervalMs)
  })
  return () => { stop(); if (timer) view.clearInterval(timer); timer = 0 }
}
