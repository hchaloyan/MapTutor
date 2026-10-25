import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { LOCAL_USER_ID, requireProject } from '../core/db'
import { listFiles } from './files'
import { httpError } from '../core/http'
import { deleteStudySessions } from '../core/sessions'
import { usageByModel } from '../core/usage'

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const body = (field: string, maxLength: number) => ({
  body: { type: 'object', required: [field], properties: { [field]: text(maxLength) } },
})

type Params = { Params: { id: string } }

function nonBlank(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw httpError(400, `${label} can't be blank.`)
  return trimmed
}

export function projectRoutes(app: FastifyInstance, db: DatabaseSync) {
  const studies = (projectId: string, studyId?: string) =>
    db
      .prepare(
        `SELECT s.id, s.goal, s.title, s.phase, s.created_at AS createdAt,
           count(CASE WHEN n.state = 'untested' THEN 1 END) AS untested,
           count(CASE WHEN n.state = 'missed' THEN 1 END) AS missed,
           count(CASE WHEN n.state = 'frontier' THEN 1 END) AS frontier,
           count(CASE WHEN n.state = 'known' THEN 1 END) AS known
         FROM studies s LEFT JOIN nodes n ON n.study_id = s.id
         WHERE s.project_id = ? AND (? IS NULL OR s.id = ?)
         GROUP BY s.id ORDER BY s.created_at DESC, s.rowid DESC`,
      )
      .all(projectId, studyId ?? null, studyId ?? null)
      .map(({ untested, missed, frontier, known, ...s }) => ({
        ...s,
        counts: { untested, missed, frontier, known },
        usage: usageByModel(db, 'study_id', s.id as string),
      }))

  app.get('/api/projects', async () =>
    db
      .prepare(
        `SELECT id, name, created_at AS createdAt,
           (SELECT count(*) FROM studies WHERE project_id = p.id) AS goalCount,
           (SELECT count(*) FROM files WHERE project_id = p.id) AS fileCount
         FROM projects p ORDER BY created_at DESC, rowid DESC`,
      )
      .all(),
  )

  app.post<{ Body: { name: string } }>('/api/projects', { schema: body('name', 200) }, async (req, reply) => {
    const project = { id: crypto.randomUUID(), name: nonBlank(req.body.name, 'Name'), createdAt: Date.now() }
    db.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      project.id, LOCAL_USER_ID, project.name, project.createdAt,
    )
    return reply.code(201).send(project)
  })

  app.get<Params>('/api/projects/:id', async req => {
    const project = requireProject(db, req.params.id)
    return { ...project, files: listFiles(db, req.params.id), studies: studies(req.params.id), usage: usageByModel(db, 'project_id', req.params.id) }
  })

  app.patch<Params & { Body: { name: string } }>('/api/projects/:id', { schema: body('name', 200) }, async req => {
    requireProject(db, req.params.id)
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(nonBlank(req.body.name, 'Name'), req.params.id)
    return requireProject(db, req.params.id)
  })

  app.delete<Params>('/api/projects/:id', async (req, reply) => {
    requireProject(db, req.params.id)
    const studies = db.prepare('SELECT id FROM studies WHERE project_id = ?').all(req.params.id) as { id: string }[]
    deleteStudySessions(db, studies.map(s => s.id))
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id)
    return reply.code(204).send()
  })

  app.post<Params & { Body: { goal: string } }>('/api/projects/:id/studies', { schema: body('goal', 2000) }, async (req, reply) => {
    requireProject(db, req.params.id)
    const id = crypto.randomUUID()
    db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES (?, ?, ?, 'probe', ?)").run(
      id, req.params.id, nonBlank(req.body.goal, 'Goal'), Date.now(),
    )
    return reply.code(201).send(studies(req.params.id, id)[0])
  })
}
