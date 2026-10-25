import '@fontsource/nunito/400.css'
import '@fontsource/nunito/600.css'
import '@fontsource/nunito/700.css'
import '@fontsource/nunito/800.css'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initialTheme } from './lib/theme'

document.documentElement.dataset.theme = initialTheme()
// Clear the API key saved before the Agent SDK switch
try {
  localStorage.removeItem('maptutor.key')
  localStorage.removeItem('maptutor.welcomeDismissed')
} catch {}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
