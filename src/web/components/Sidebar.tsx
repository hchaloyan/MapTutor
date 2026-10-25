import { Plus } from 'lucide-react'
import { useState } from 'react'
import type { ProjectSummary } from '../lib/api'
import { countLabel } from '../lib/format'
import { navigate } from '../lib/router'

export function Sidebar(props: {
  projects: ProjectSummary[]
  openId: string | null
  creating: boolean
  setCreating(on: boolean): void
  onCreate(name: string): Promise<void>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cancel = () => {
    setName('')
    setError(null)
    props.setCreating(false)
  }
  async function create() {
    if (!name.trim()) return
    try {
      await props.onCreate(name.trim())
      cancel()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span>PROJECTS</span>
        <button className="text-action" onClick={() => props.setCreating(true)}>
          <Plus size={14} strokeWidth={3} /> New
        </button>
      </div>
      {props.creating && (
        <div className="sidebar-new">
          <input
            autoFocus
            value={name}
            aria-label="Project name"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => (e.key === 'Enter' ? create() : e.key === 'Escape' && cancel())}
            onBlur={() => !name.trim() && cancel()}
          />
          <div className="sidebar-hint">{error ?? 'Enter to create · Esc to cancel'}</div>
        </div>
      )}
      <div className="sidebar-list">
        {props.projects.map(p => (
          <button key={p.id} className={`sidebar-item${p.id === props.openId ? ' open' : ''}`} onClick={() => navigate(`/projects/${p.id}`)}>
            <span className="ellipsis">{p.name}</span>
            <span className="sidebar-meta">
              {countLabel(p.goalCount, 'goal')} · {countLabel(p.fileCount, 'file')}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
