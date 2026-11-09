/** Runs `tick` every `intervalMs` while the window is shown; nothing stays armed while it is hidden. */
export function whileVisible(tick: () => void, intervalMs: number): () => void {
  let timer = 0
  const sync = (): void => {
    if (document.hidden) { if (timer) window.clearInterval(timer); timer = 0 }
    else if (!timer) timer = window.setInterval(tick, intervalMs)
  }
  document.addEventListener('visibilitychange', sync)
  sync()
  return () => { document.removeEventListener('visibilitychange', sync); if (timer) window.clearInterval(timer) }
}
