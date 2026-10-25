import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'maptutor.theme'

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  return stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light'
}

function stored() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

/** Set before the first render so the page never flashes the other theme. */
export const initialTheme = () => resolveTheme(stored(), darkQuery().matches)

/** The theme follows the OS until the toggle picks one, which is remembered. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const query = darkQuery()
    const follow = () => stored() ?? setTheme(query.matches ? 'dark' : 'light')
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [])
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(KEY, next)
    } catch {}
    setTheme(next)
  }
  return [theme, toggle]
}
