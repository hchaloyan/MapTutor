import { useState } from 'react'
import { KeyField } from '../components/KeyField'
import { useApp } from '../lib/app'
import { checkAndSave } from '../lib/key'

export function Welcome({ onDismiss }: { onDismiss(): void }) {
  const app = useApp()
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function save() {
    const key = draft.trim()
    if (!key || checking) return
    setChecking(true)
    try {
      if (await checkAndSave(key)) {
        app.setKeyStatus('accepted')
        app.setKey(key)
      } else setProblem('✗ Anthropic rejected this key')
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="welcome">
      <div className="wordmark welcome-brand">MapTutor</div>
      <div className="welcome-card popover">
        <h1>Bring your own key</h1>
        <p>
          MapTutor talks to Claude using your Anthropic API key. It's saved only in this browser and passed to Anthropic with each request, never
          stored on the server.{' '}
          <a className="nowrap" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            Get a key →
          </a>
        </p>
        <KeyField
          value={draft}
          autoFocus
          onChange={v => {
            setDraft(v)
            setProblem(null)
          }}
          onEnter={save}
        />
        <div className="welcome-actions">
          {problem ? (
            <span className="key-status rejected">{problem}</span>
          ) : (
            <button className="text-action muted" onClick={onDismiss}>
              Look around first
            </button>
          )}
          <button className="btn btn-primary" disabled={!draft.trim() || checking} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
