import { useState } from 'react'

/** A monospace key input with a Show / Hide toggle inside it. `display` overrides what an unedited field shows. */
export function KeyField(props: {
  value: string
  onChange(value: string): void
  onEnter?(): void
  display?: (shown: boolean) => string | null
  autoFocus?: boolean
}) {
  const [shown, setShown] = useState(false)
  const fixed = props.display?.(shown) ?? null
  return (
    <div className="key-field">
      <input
        type={shown || fixed !== null ? 'text' : 'password'}
        value={fixed ?? props.value}
        placeholder="sk-ant-…"
        spellCheck={false}
        autoComplete="off"
        autoFocus={props.autoFocus}
        aria-label="Anthropic API key"
        onFocus={e => fixed !== null && e.currentTarget.select()}
        onChange={e => props.onChange(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && props.onEnter?.()}
      />
      <button type="button" className="key-toggle" onClick={() => setShown(s => !s)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}
