import { createContext, useContext } from 'react'

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
