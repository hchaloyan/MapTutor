import '@xyflow/react/dist/base.css'
import {
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Study, StudyNode } from '../lib/api'
import { STATES } from '../lib/format'
import { boxSize, labelSize, layout, layoutKey, lightTimings, lineLength, radius } from '../lib/graph'

type CircleData = { node: StudyNode; open: boolean; taught: boolean; clickable: boolean }
type CircleNode = Node<CircleData, 'circle'>
type Timing = { delay: number; duration: number; cycle: number; light: number }

const PAD = 12 // box padding around the circle (see boxSize)
const RING = 9 // root ring distance outside the circle
const SPEED = 250 // the light toward the open node, px per second at zoom 1
const LIGHT = 20 // its length in px at zoom 1
const TIP = 8 // a line stops this far into its arrowhead
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const sourceBottom = (kind: StudyNode['kind']) => (kind === 'root' ? PAD - RING - 1.5 : PAD)

/**
 * Where React Flow would measure the two 5px handles. Giving them up front keeps the edges drawn: a controlled node
 * rebuilt without `measured` otherwise drops its handle bounds, and the edges vanish until a re-measure that can miss.
 */
const handles = (kind: StudyNode['kind']) => {
  const size = boxSize(kind)
  return [
    { type: 'target' as const, position: Position.Top, x: size / 2, y: PAD - 2.5, width: 0, height: 0 },
    { type: 'source' as const, position: Position.Bottom, x: size / 2, y: size - sourceBottom(kind) + 2.5, width: 0, height: 0 },
  ]
}

const LightContext = createContext<Map<string, Timing>>(new Map())

function Circle({ data }: NodeProps<CircleNode>) {
  const { node, open, taught, clickable } = data
  const r = radius(node.kind)
  const size = boxSize(node.kind)
  const c = size / 2
  const fill = { fill: `var(--${node.state})` }
  const circle = useRef<SVGCircleElement>(null)
  const last = useRef(node.state)

  // A state change fades the fill (CSS) and gives one small bounce.
  useEffect(() => {
    if (last.current === node.state) return
    last.current = node.state
    if (!reducedMotion()) circle.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' })
  }, [node.state])

  return (
    <div className={`map-node ${node.kind}${open ? ' open' : ''}${clickable ? ' clickable' : ''}`} style={{ width: size, height: size }}>
      <Handle type="target" position={Position.Top} isConnectable={false} style={{ top: PAD }} />
      <div className="map-pop">
        <svg width={size} height={size} overflow="visible" aria-hidden="true">
          {taught && (
            <>
              <circle className="map-ripple" cx={c} cy={c} r={r} style={fill} />
              <circle className="map-ripple late" cx={c} cy={c} r={r} style={fill} />
            </>
          )}
          {node.kind === 'root' && <circle className="map-ring" cx={c} cy={c} r={r + RING} />}
          <circle ref={circle} className="map-circle" cx={c} cy={c} r={r} style={{ ...fill, strokeWidth: node.kind === 'goal' ? 6 : 4 }} />
        </svg>
        <div className="map-label" style={{ fontSize: labelSize(node.label, node.kind), width: r * 1.62 }}>
          {node.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={{ bottom: sourceBottom(node.kind) }} />
    </div>
  )
}

function Line({ source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const timing = useContext(LightContext).get(`${source}→${target}`)
  const light = useRef<SVGPathElement>(null)
  // Stop the line inside the arrowhead so its round cap never pokes past the tip.
  const [d] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY: targetY - TIP, targetPosition, curvature: 0.35 })
  const arrow = `M ${targetX} ${targetY} L ${targetX - 7} ${targetY - 11} L ${targetX + 7} ${targetY - 11} Z`

  // The light enters at the start and runs on past the end, where the arrowhead (drawn above it) covers it.
  useEffect(() => {
    if (!timing || !light.current || reducedMotion()) return
    const end = -light.current.getTotalLength()
    const run = light.current.animate(
      [{ strokeDashoffset: timing.light }, { strokeDashoffset: end, offset: timing.duration / timing.cycle }, { strokeDashoffset: end }],
      { duration: timing.cycle * 1000, delay: timing.delay * 1000, iterations: Infinity },
    )
    return () => run.cancel()
  }, [timing?.delay, timing?.duration, timing?.cycle, timing?.light])

  return (
    <g>
      <path className="map-line" d={d} />
      {timing && <path ref={light} className="map-light" d={d} style={{ strokeDasharray: `${timing.light} 100000`, strokeDashoffset: timing.light }} />}
      <path className="map-arrow" d={arrow} />
    </g>
  )
}

const nodeTypes = { circle: Circle }
const edgeTypes = { line: Line }

function HoverCard({ node, at }: { node: StudyNode; at: { left: number; top: number } }) {
  const { correct, total } = node.evidence
  return (
    <div className="hover-card popover" style={at}>
      <div className="hover-title">{node.label}</div>
      <p>{node.description}</p>
      {node.summary && (
        <>
          <div className="hover-head">What you established</div>
          <p>{node.summary}</p>
        </>
      )}
      {total === 0 ? (
        <div className="hover-evidence muted">No quiz yet</div>
      ) : (
        <div className="hover-evidence">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < correct ? 'ok' : 'no'} />
          ))}
          <span>
            {correct}/{total} correct
          </span>
        </div>
      )}
    </div>
  )
}

function Legend({ nodes }: { nodes: StudyNode[] }) {
  const counts = STATES.map(state => ({ state, count: nodes.filter(n => n.state === state).length }))
  return (
    <div className="legend surface">
      <div className="legend-bar" aria-hidden="true">
        {counts
          .filter(c => c.count)
          .map(c => (
            <i key={c.state} style={{ flex: c.count, background: `var(--${c.state})` }} />
          ))}
      </div>
      <div className="legend-key">
        {counts.map(c => (
          <span key={c.state}>
            <i style={{ background: `var(--${c.state})` }} />
            {c.state[0].toUpperCase() + c.state.slice(1)} {c.count}
          </span>
        ))}
      </div>
    </div>
  )
}

function Zoom() {
  const flow = useReactFlow()
  return (
    <div className="zoom surface">
      <button aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 200 })}>
        +
      </button>
      <button aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 200 })}>
        −
      </button>
      <button aria-label="Fit the map" onClick={() => flow.fitView({ padding: 0.12, duration: 300 })}>
        ⤢
      </button>
    </div>
  )
}

function Graph({ study, openId, onOpen, clickable }: { study: Study; openId: string | null; onOpen(id: string): void; clickable: boolean }) {
  const flow = useReactFlow()
  const pane = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ id: string; at: { left: number; top: number } } | null>(null)
  const key = layoutKey(study.nodes, study.edges)
  // Re-layout only when the graph is (re)proposed; state changes recolor in place.
  const positions = useMemo(() => layout(study.nodes, study.edges), [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const frame = requestAnimationFrame(() => flow.fitView({ padding: 0.12 }))
    return () => cancelAnimationFrame(frame)
  }, [key, flow])

  const nodes: CircleNode[] = study.nodes.map(n => ({
    id: n.id,
    type: 'circle',
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: { node: n, open: n.id === openId, taught: n.id === study.focusNodeId, clickable },
    zIndex: n.id === openId ? 10 : n.id === hover?.id ? 5 : 0,
    width: boxSize(n.kind),
    height: boxSize(n.kind),
    handles: handles(n.kind),
  }))
  const edges: Edge[] = study.edges.map(e => ({ id: `${e.from}→${e.to}`, source: e.from, target: e.to, type: 'line' }))
  // Each line's length from the layout and the handle points, as React Flow draws it.
  const lengths = useMemo(() => {
    const point = (id: string, type: 'source' | 'target') => {
      const p = positions.get(id) ?? { x: 0, y: 0 }
      const h = handles(study.nodes.find(n => n.id === id)!.kind).find(h => h.type === type)!
      return { x: p.x + h.x, y: p.y + h.y }
    }
    return new Map(study.edges.map(e => {
      const [s, t] = [point(e.from, 'source'), point(e.to, 'target')]
      return [`${e.from}→${e.to}`, lineLength(s.x, s.y, t.x, t.y - TIP)]
    }))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const timings = useMemo(
    () => (openId ? lightTimings(study.edges, openId, lengths, SPEED, LIGHT) : new Map<string, Timing>()),
    [openId, lengths], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const hovered = study.nodes.find(n => n.id === hover?.id)

  return (
    <div ref={pane} className="map">
      <LightContext.Provider value={timings}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          // Only a real pan or zoom hides the hover card; `onMoveStart` also fires on a plain click.
          onMove={() => setHover(null)}
          onNodeClick={(_e, n) => clickable && onOpen(n.id)}
          onNodeMouseEnter={(e, n) => {
            const circle = (e.currentTarget as HTMLElement).querySelector('.map-circle')!.getBoundingClientRect()
            const box = pane.current!.getBoundingClientRect()
            // Beside the node: right, else left, else below it when the pane is too narrow for either side.
            const width = 240
            const right = circle.right - box.left + 14
            const left = circle.left - box.left - 14 - width
            const at =
              right + width <= box.width - 8
                ? { left: right, top: circle.top - box.top }
                : left >= 8
                  ? { left, top: circle.top - box.top }
                  : { left: Math.min(Math.max(8, circle.left - box.left + circle.width / 2 - width / 2), box.width - width - 8), top: circle.bottom - box.top + 12 }
            setHover({ id: n.id, at: { left: at.left, top: Math.max(8, at.top) } })
          }}
          onNodeMouseLeave={() => setHover(null)}
        />
      </LightContext.Provider>
      {hovered && hover && <HoverCard node={hovered} at={hover.at} />}
      <Legend nodes={study.nodes} />
      <Zoom />
    </div>
  )
}

/** The map: sticker circles in state colors, laid out top to bottom, roots first and the goal last. */
export function StudyMap(props: { study: Study; openId: string | null; onOpen(id: string): void; clickable: boolean }) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  )
}
