import { type ReactNode, useEffect, useRef, useState } from 'react'
import { clampSplit } from '../lib/format'

const KEY = 'maptutor.split'

/** Graph left, chat right, 50/50 to start; the divider's position is remembered. */
export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [pct, setPct] = useState(() => clampSplit(Number(localStorage.getItem(KEY)) || 50))
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => localStorage.setItem(KEY, String(Math.round(pct))), [pct])

  function drag(e: React.PointerEvent) {
    e.preventDefault()
    const rect = box.current!.getBoundingClientRect()
    const move = (ev: PointerEvent) => setPct(clampSplit(((ev.clientX - rect.left) / rect.width) * 100))
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return (
    <div ref={box} className="split">
      <div className="split-pane" style={{ width: `${pct}%` }}>
        {left}
      </div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={e => (e.key === 'ArrowLeft' ? setPct(p => clampSplit(p - 5)) : e.key === 'ArrowRight' && setPct(p => clampSplit(p + 5)))}
      />
      <div className="split-pane grow">{right}</div>
    </div>
  )
}
