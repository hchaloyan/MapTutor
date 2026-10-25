import { useRef, useState } from 'react'
import type { Usage } from '../lib/api'
import { useDismiss } from '../lib/app'
import { formatTokens, modelName, usageTotals } from '../lib/format'

/** **Usage** and its popover: a headline total, then one block per model. Tokens only. */
export function UsageButton({ usage, scope }: { usage: Usage; scope: 'goal' | 'project' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(ref, open, () => setOpen(false))
  const total = usageTotals(usage)

  return (
    <div ref={ref} className="key-anchor">
      <button className="btn btn-secondary btn-small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Usage
      </button>
      {open && (
        <div className="usage-panel popover" role="dialog" aria-label="Usage">
          <h2>Usage for this {scope}</h2>
          <div className="usage-total">{formatTokens(total.tokens)} tokens</div>
          <div className="muted">
            {total.searches} web search{total.searches === 1 ? '' : 'es'}
          </div>
          {usage.map(u => (
            <div key={u.model} className="usage-model">
              <b>{modelName(u.model)}</b>
              <div className="usage-grid">
                <span>Input</span>
                <span>{formatTokens(u.inputTokens)}</span>
                <span>Output</span>
                <span>{formatTokens(u.outputTokens)}</span>
                <span>Cached</span>
                <span>{formatTokens(u.cacheReadTokens + u.cacheWriteTokens)}</span>
                {u.webSearches > 0 && (
                  <>
                    <span>Searches</span>
                    <span>{u.webSearches}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
