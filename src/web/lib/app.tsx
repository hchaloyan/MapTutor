import { createContext, type RefObject, useContext, useEffect } from 'react'

export type KeyStatus = 'accepted' | 'rejected' | null

export type AppState = {
  key: string | null
  setKey(key: string | null): void
  keyStatus: KeyStatus
  setKeyStatus(status: KeyStatus): void
  keyPanelOpen: boolean
  setKeyPanelOpen(open: boolean): void
  /** True when a key is saved; otherwise opens the API key panel so the user can add one. */
  requireKey(): boolean
}

export const AppContext = createContext<AppState | null>(null)

export function useApp(): AppState {
  const app = useContext(AppContext)
  if (!app) throw new Error('useApp needs <AppContext.Provider>.')
  return app
}

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
