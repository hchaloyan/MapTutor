import { type RefObject, useEffect } from 'react'

/** While `open`, a pointerdown outside `ref` or Escape calls `close` (popovers under top bar buttons). */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [ref, open, close])
}
