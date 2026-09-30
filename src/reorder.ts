/** Immutable array move: returns a copy of `list` with the item at `from`
 *  relocated to `to`. Out-of-range indices yield an unchanged copy. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

export type DragLike = {
  preventDefault: () => void
  dataTransfer?: { effectAllowed?: string; dropEffect?: string; setDragImage?: (image: Element, x: number, y: number) => void }
  clientX?: number
  clientY?: number
  currentTarget?: Element & { getBoundingClientRect: () => { top: number; height: number; left: number; width: number } }
}
export const setIconDragImage = (source: Element | null | undefined, dataTransfer?: DragLike['dataTransfer']): void => {
  if (!source || !dataTransfer?.setDragImage) return
  const document = source.ownerDocument
  const image = document.createElement('div')
  image.className = 'clock-drag-ghost'
  image.appendChild(source.cloneNode(true))
  document.body.appendChild(image)
  dataTransfer.setDragImage(image, 12, 12)
  window.setTimeout(() => image.remove(), 0)
}
export const dropDestination = (from: number, target: number, after: boolean): number => {
  const insertion = after ? target + 1 : target
  return from < insertion ? insertion - 1 : insertion
}
