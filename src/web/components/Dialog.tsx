import { useEffect, useState } from 'react'

/** A centered card over a light wash (never a blur). Delete runs `onConfirm`; a thrown error shows in the card. */
export function ConfirmDialog(props: { title: string; body: string; onCancel(): void; onConfirm(): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && props.onCancel()
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [props])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="wash" onPointerDown={e => e.target === e.currentTarget && props.onCancel()}>
      <div className="dialog popover" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{props.title}</h2>
        <p>{props.body}</p>
        {error && <div className="error-line">{error}</div>}
        <div className="dialog-actions">
          <button className="btn btn-secondary" autoFocus onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={confirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
