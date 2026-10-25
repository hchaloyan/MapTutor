import { useMemo, useState } from 'react'
import { AppContext, type AppState, type KeyStatus } from './lib/app'
import { getKey } from './lib/key'
import { useRoute } from './lib/router'
import { Projects } from './pages/Projects'
import { Welcome } from './pages/Welcome'

const DISMISSED = 'maptutor.welcomeDismissed'

export function App() {
  const route = useRoute()
  const [key, setKey] = useState(getKey)
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(null)
  const [keyPanelOpen, setKeyPanelOpen] = useState(false)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED) === '1')

  const app = useMemo<AppState>(
    () => ({
      key,
      setKey,
      keyStatus,
      setKeyStatus,
      keyPanelOpen,
      setKeyPanelOpen,
      requireKey: () => {
        if (!key) setKeyPanelOpen(true)
        return !!key
      },
    }),
    [key, keyStatus, keyPanelOpen],
  )

  const dismiss = () => {
    localStorage.setItem(DISMISSED, '1')
    setDismissed(true)
  }

  return (
    <AppContext.Provider value={app}>
      {!key && !dismissed ? (
        <Welcome onDismiss={dismiss} />
      ) : route.name === 'goal' ? (
        <p>Goal {route.goalId}</p>
      ) : (
        <Projects projectId={route.projectId} />
      )}
    </AppContext.Provider>
  )
}
