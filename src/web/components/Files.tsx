import { useRef, useState } from 'react'
import { api, type FileInfo, type Project, uploadAll } from '../lib/api'
import { useApp } from '../lib/app'
import { fileBadge, formatBytes, usedLabel } from '../lib/format'
import { ConfirmDialog } from './Dialog'

const ACCEPT = '.pdf,.md,.txt,image/png,image/jpeg,image/gif,image/webp'

/** The project's files. The whole box takes dropped files; links need a key because pages are converted by Claude. */
export function Files({ project, onChange }: { project: Project; onChange(): void }) {
  const app = useApp()
  const [errors, setErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [linking, setLinking] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 'upload', 'link', or the id of a file being refreshed
  const [deleting, setDeleting] = useState<FileInfo | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const used = project.files.reduce((n, f) => n + f.size, 0)

  async function run(what: string, work: () => Promise<string[]>) {
    setBusy(what)
    try {
      setErrors(await work())
      onChange()
    } catch (err) {
      setErrors([(err as Error).message])
    } finally {
      setBusy(null)
    }
  }

  const upload = (files: File[]) => files.length && run('upload', () => uploadAll(project.id, files))

  const addLink = () =>
    url.trim() &&
    app.requireKey() &&
    run('link', async () => {
      await api(`/api/projects/${project.id}/urls`, { method: 'POST', json: { url: url.trim() } })
      setUrl('')
      setLinking(false)
      return []
    })

  const refresh = (f: FileInfo) =>
    app.requireKey() &&
    run(f.id, () =>
      api(`/api/files/${f.id}/refresh`, { method: 'POST' }).then(
        () => [],
        (err: Error) => [`${f.name}: ${err.message}`],
      ),
    )

  const browse = (
    <button className="text-action" onClick={() => picker.current?.click()}>
      browse
    </button>
  )
  const link = (
    <button className="text-action" onClick={() => setLinking(true)}>
      add link
    </button>
  )

  return (
    <section>
      <div className="section-head">FILES</div>
      <div
        className={`surface files${dragging ? ' dragging' : ''}`}
        onDragOver={e => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
        onDrop={e => {
          e.preventDefault()
          setDragging(false)
          upload([...e.dataTransfer.files])
        }}
      >
        {project.files.map(f => {
          const badge = fileBadge(f)
          return (
            <div key={f.id} className="row file-row">
              <span className="file-badge" style={{ background: badge.color }}>
                {badge.label}
              </span>
              <span className="file-name ellipsis" title={f.url ?? f.name}>
                {f.name}
              </span>
              <span className="file-size">{formatBytes(f.size)}</span>
              {f.kind === 'url' && (
                <button className="text-action file-refresh" disabled={busy === f.id} onClick={() => refresh(f)}>
                  {busy === f.id ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
              <button className="row-x" aria-label={`Delete ${f.name}`} onClick={() => setDeleting(f)}>
                ✕
              </button>
            </div>
          )
        })}
        {linking ? (
          <div className="row file-link">
            <input
              autoFocus
              type="url"
              value={url}
              placeholder="https://…"
              aria-label="Link to add"
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => (e.key === 'Enter' ? addLink() : e.key === 'Escape' && setLinking(false))}
            />
            <button className="btn btn-primary" disabled={!url.trim() || busy === 'link'} onClick={addLink}>
              Add
            </button>
            <button className="btn btn-secondary" onClick={() => setLinking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row file-drop">
            {project.files.length ? (
              <>
                <span>
                  Drop files here or {browse} · {link}
                </span>
                <span className="file-note">{busy === 'upload' ? 'Uploading…' : usedLabel(used)}</span>
              </>
            ) : (
              <>
                <span>
                  Drop slides, notes or images here, or {browse} · {link}
                </span>
                <span className="file-note">{busy === 'upload' ? 'Uploading…' : 'PDF, images, .md, .txt, links · up to 20 MB per project'}</span>
              </>
            )}
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={e => {
            upload([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>
      {errors.map(e => (
        <div key={e} className="error-line">
          {e}
        </div>
      ))}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body={`This removes it from ${project.name}. It can't be undone.`}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/api/files/${deleting.id}`, { method: 'DELETE' })
            setDeleting(null)
            onChange()
          }}
        />
      )}
    </section>
  )
}
