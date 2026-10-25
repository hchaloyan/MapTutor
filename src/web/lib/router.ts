import { useEffect, useState } from 'react'

export type Route = { name: 'projects'; projectId: string | null } | { name: 'goal'; goalId: string }

export function matchRoute(path: string): Route {
  const [, kind, id] = path.split('/')
  if (kind === 'goals' && id) return { name: 'goal', goalId: id }
  return { name: 'projects', projectId: kind === 'projects' && id ? id : null }
}

export function navigate(path: string, state?: object, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](state ?? null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}

export function useRoute(): Route {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const update = () => setPath(location.pathname)
    addEventListener('popstate', update)
    return () => removeEventListener('popstate', update)
  }, [])
  return matchRoute(path)
}
