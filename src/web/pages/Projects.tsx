import { useCallback, useEffect, useState } from 'react'
import { ProjectPage } from '../components/ProjectPage'
import { Sidebar } from '../components/Sidebar'
import { TopBar } from '../components/TopBar'
import { api, type Project, type ProjectSummary } from '../lib/api'
import { navigate } from '../lib/router'

export function Projects({ projectId }: { projectId: string | null }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const list = await api<ProjectSummary[]>('/api/projects')
      setProjects(list)
      // `/` and a project that no longer exists both open the newest project.
      const openId = list.some(p => p.id === projectId) ? projectId : (list[0]?.id ?? null)
      if (openId !== projectId) return navigate(openId ? `/projects/${openId}` : '/', undefined, true)
      setProject(openId ? await api<Project>(`/api/projects/${openId}`) : null)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    reload()
  }, [reload])

  async function create(name: string) {
    const created = await api<ProjectSummary>('/api/projects', { method: 'POST', json: { name } })
    navigate(`/projects/${created.id}`)
  }

  function afterDelete() {
    const list = projects ?? []
    const i = list.findIndex(p => p.id === projectId)
    const next = list[i + 1] ?? list[i - 1]
    navigate(next ? `/projects/${next.id}` : '/', undefined, true)
    if (!next) reload()
  }

  return (
    <div className="app">
      <TopBar left={<span className="wordmark">MapTutor</span>} />
      <main className="page">
        <Sidebar projects={projects ?? []} openId={projectId} creating={creating} setCreating={setCreating} onCreate={create} />
        {error ? (
          <div className="first-run">
            <div className="error-line">{error}</div>
          </div>
        ) : projects?.length === 0 ? (
          <div className="first-run">
            <h1>No projects yet</h1>
            <p>A project is a subject and its materials: slides, notes, links. Each one holds as many goals as you like.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              + New project
            </button>
          </div>
        ) : (
          project && project.id === projectId && <ProjectPage key={project.id} project={project} onChange={reload} onDeleted={afterDelete} />
        )}
      </main>
    </div>
  )
}
