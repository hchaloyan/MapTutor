import type { ReactNode } from 'react'
import { useTheme } from '../lib/theme'

/** The bar over every screen: screen-specific content left and center, then the shared buttons. */
export function TopBar({ left, center, right }: { left: ReactNode; center?: ReactNode; right?: ReactNode }) {
  const [theme, toggle] = useTheme()
  return (
    <header className="topbar">
      <div className="topbar-left">{left}</div>
      <div>{center}</div>
      <div className="topbar-right">
        {right}
        <button className="btn btn-secondary btn-small" onClick={toggle} aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </header>
  )
}
