import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/app'
import { checkAndSave, maskKey, removeKey } from '../lib/key'
import { KeyField } from './KeyField'

/** ⚙ API key and its popover. The saved key is checked once when the panel first opens. */
export function KeyButton() {
  const app = useApp()
  const ref = useRef<HTMLDivElement>(null)
  const open = app.keyPanelOpen

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && app.setKeyPanelOpen(false)
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && app.setKeyPanelOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, app])

  return (
    <div ref={ref} className="key-anchor">
      <button className="btn btn-secondary btn-small" aria-expanded={open} onClick={() => app.setKeyPanelOpen(!open)}>
        ⚙ API key
      </button>
      {open && <KeyPanel />}
    </div>
  )
}

function KeyPanel() {
  const app = useApp()
  const [draft, setDraft] = useState<string | null>(null) // null until the field is edited
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { key, keyStatus, setKeyStatus } = app

  useEffect(() => {
    if (!key || keyStatus) return
    // Re-saving the same key on success is harmless.
    checkAndSave(key).then(ok => setKeyStatus(ok ? 'accepted' : 'rejected'), () => {})
  }, [key, keyStatus, setKeyStatus])

  async function save() {
    const next = draft?.trim()
    if (!next || checking) return
    setChecking(true)
    try {
      const ok = await checkAndSave(next)
      setKeyStatus(ok ? 'accepted' : 'rejected')
      if (ok) {
        app.setKey(next)
        setDraft(null)
      }
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const edited = draft !== null
  const status = problem ? (
    <span className="key-status rejected">{problem}</span>
  ) : keyStatus === 'accepted' && !edited ? (
    <span className="key-status accepted">✓ Key accepted by Anthropic</span>
  ) : keyStatus === 'rejected' ? (
    <span className="key-status rejected">✗ Anthropic rejected this key</span>
  ) : (
    <span />
  )

  return (
    <div className="key-panel popover" role="dialog" aria-label="API key">
      <div className="key-panel-head">
        <h2>API key</h2>
        {key && (
          <button
            className="text-action danger"
            onClick={() => {
              removeKey()
              app.setKey(null)
              setKeyStatus(null)
              setDraft(null)
            }}
          >
            Remove
          </button>
        )}
      </div>
      <KeyField
        value={draft ?? key ?? ''}
        display={shown => (!edited && key && !shown ? maskKey(key) : null)}
        onChange={v => {
          setDraft(v)
          setProblem(null)
          if (keyStatus === 'rejected') setKeyStatus(null)
        }}
        onEnter={save}
        autoFocus={!key}
      />
      <div className="key-panel-status">
        {status}
        {edited && (
          <button className="btn btn-primary" disabled={!draft.trim() || checking} onClick={save}>
            Save
          </button>
        )}
      </div>
    </div>
  )
}
