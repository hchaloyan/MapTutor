import { useRoute } from './lib/router'
import { Goal } from './pages/Goal'
import { Projects } from './pages/Projects'

export function App() {
  const route = useRoute()
  return route.name === 'goal' ? <Goal key={route.goalId} goalId={route.goalId} /> : <Projects projectId={route.projectId} />
}
