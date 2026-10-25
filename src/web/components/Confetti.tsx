import { useEffect, useRef } from 'react'

const COLORS = ['known', 'frontier', 'missed', 'untested', 'accent']
const PIECES = 80
const DURATION = 1800 // ms
const GRAVITY = 1400 // px/s²
const FRAMES = 12

/** One burst of confetti from `origin` (pane coordinates): pieces fly up and fall under gravity, then `onDone`. */
export function Confetti({ origin, onDone }: { origin: { x: number; y: number }; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const runs = [...ref.current!.children].map(el => {
      const angle = ((-90 + (Math.random() - 0.5) * 100) * Math.PI) / 180
      const speed = 350 + Math.random() * 450
      const [vx, vy] = [Math.cos(angle) * speed, Math.sin(angle) * speed]
      const spin = (Math.random() - 0.5) * 1440
      // Sampled parabola; the last quarter fades out.
      const frames = Array.from({ length: FRAMES + 1 }, (_, i) => {
        const t = ((i / FRAMES) * DURATION) / 1000
        return {
          transform: `translate(${vx * t}px, ${vy * t + (GRAVITY * t * t) / 2}px) rotate(${(spin * i) / FRAMES}deg)`,
          opacity: Math.min(1, (FRAMES - i) / (FRAMES / 4)),
        }
      })
      return el.animate(frames, { duration: DURATION, fill: 'forwards' })
    })
    Promise.all(runs.map(r => r.finished)).then(onDone, () => {})
    return () => runs.forEach(r => r.cancel())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="confetti" style={{ left: origin.x, top: origin.y }} aria-hidden="true">
      {Array.from({ length: PIECES }, (_, i) => (
        <i key={i} style={{ background: `var(--${COLORS[i % COLORS.length]})`, width: 6 + (i % 3) * 2 }} />
      ))}
    </div>
  )
}
