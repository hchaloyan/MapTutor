import { useState } from 'react'
import { api, type Project } from '../lib/api'
import { countLabel } from '../lib/format'
import { ConfirmDialog } from './Dialog'
import { Files } from './Files'
import { GoalList, NewGoal } from './Goals'

/** "its 3 goals, their maps and chats, and its 4 files", leaving out what the project doesn't have. */
function deleteBody(goals: number, files: number) {
  const parts = [
    goals > 0 && `its ${countLabel(goals, 'goal')}, ${goals === 1 ? 'its map and chats' : 'their maps and chats'}`,
    files > 0 && `its ${countLabel(files, 'file')}`,
  ].filter(Boolean)
  return `This removes ${parts.length ? parts.join(', and ') : 'the project'}. It can't be undone.`
}

export function ProjectPage({ project, onChange, onDeleted }: { project: Project; onChange(): void; onDeleted(): void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function rename() {
    if (editing === null) return
    try {
      if (editing.trim() && editing.trim() !== project.name) {
        await api(`/api/projects/${project.id}`, { method: 'PATCH', json: { name: editing } })
        onChange()
      }
      setEditing(null)
      setRenameError(null)
    } catch (err) {
      setRenameError((err as Error).message)
    }
  }

  return (
    <div className="project-area">
      <div className="project-title">
        {editing === null ? (
          <button className="project-name ellipsis" title="Rename" onClick={() => setEditing(project.name)}>
            {project.name}
          </button>
        ) : (
          <div className="project-rename">
            <input
              autoFocus
              value={editing}
              aria-label="Project name"
              onChange={e => setEditing(e.target.value)}
              onKeyDown={e => (e.key === 'Enter' ? rename() : e.key === 'Escape' && (setEditing(null), setRenameError(null)))}
              onBlur={() => setEditing(null)}
            />
            <span className="sidebar-hint">{renameError ?? 'Enter to save · Esc to cancel'}</span>
          </div>
        )}
        <button className="text-action danger" onClick={() => setDeleting(true)}>
          Delete project
        </button>
      </div>
      <div className="project-cols">
        <div className="project-left">
          <NewGoal projectId={project.id} />
          <GoalList studies={project.studies} onChange={onChange} />
        </div>
        <div className="project-right">
          <Files project={project} onChange={onChange} />
        </div>
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${project.name}?`}
          body={deleteBody(project.studies.length, project.files.length)}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api(`/api/projects/${project.id}`, { method: 'DELETE' })
            onDeleted()
          }}
        />
      )}
    </div>
  )
}
