/*
 * Relationship graph: a small force-directed simulation drawn as SVG (no graph library).
 * Finding nodes are rounded rects (F1…), entity nodes are circles. Clicking an entity highlights the
 * cards that mention it; clicking a finding scrolls to its card.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import type { Edge, EdgeType } from '../types';
import type { GraphNode } from '../state';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

const W = 360;
const H = 290;

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Props {
  nodes: Record<string, GraphNode>;
  edges: Edge[];
  order: string[];
  questions: Record<string, string>;
  highlight: string | null;
  onEntity: (entityId: string) => void;
  onFinding: (findingId: string) => void;
}

const EDGE_STYLE: Record<EdgeType, CSSProperties> = {
  mentions: { stroke: 'var(--line)', strokeWidth: 1.2 },
  shares_entity: { stroke: 'var(--line)', strokeWidth: 1.2 },
  similar_to: { stroke: 'var(--accent)', strokeWidth: 1.5, strokeDasharray: '2 3' },
  contradicts: { stroke: 'var(--bad)', strokeWidth: 1.6, strokeDasharray: '6 4' },
  supports: { stroke: 'var(--good)', strokeWidth: 1.5 },
  causes: { stroke: 'var(--accent)', strokeWidth: 1.5 },
};

/** shares_entity edges are drawn only when the shared entity is not already visible as a node linked to both findings. */
function visibleEdges(edges: Edge[], nodes: Record<string, GraphNode>): Edge[] {
  const mentions = new Set(edges.filter((e) => e.type === 'mentions').map((e) => e.from + '>' + e.to));
  return edges.filter((e) => {
    if (!nodes[e.from] || !nodes[e.to]) return false;
    if (e.type !== 'shares_entity') return true;
    if (!e.via || !nodes[e.via]) return true;
    return !(mentions.has(e.from + '>' + e.via) && mentions.has(e.to + '>' + e.via));
  });
}

function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

export function Graph({ nodes, edges, order, questions, highlight, onEntity, onFinding }: Props) {
  const pos = useRef(new Map<string, P>());
  const alpha = useRef(0);
  const raf = useRef(0);
  const [, setFrame] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  const drawn = useMemo(() => visibleEdges(edges, nodes), [edges, nodes]);
  const live = useRef({ nodes, drawn });
  live.current = { nodes, drawn };

  const step = () => {
    const ids = Object.keys(live.current.nodes).filter((id) => pos.current.has(id));
    const ps = ids.map((id) => pos.current.get(id)!);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = Math.min(1100 / d2, 6);
        dx /= d;
        dy /= d;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }
    for (const e of live.current.drawn) {
      const a = pos.current.get(e.from);
      const b = pos.current.get(e.to);
      if (!a || !b) continue;
      const L = e.type === 'mentions' ? 52 : 92;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const k = (d - L) * 0.02;
      a.vx += (dx / d) * k;
      a.vy += (dy / d) * k;
      b.vx -= (dx / d) * k;
      b.vy -= (dy / d) * k;
    }
    for (const n of ps) {
      n.vx += (W / 2 - n.x) * 0.004;
      n.vy += (H / 2 - n.y) * 0.006;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x = Math.max(28, Math.min(W - 28, n.x + n.vx * alpha.current));
      n.y = Math.max(16, Math.min(H - 24, n.y + n.vy * alpha.current));
    }
  };

  const settle = (iterations: number) => {
    alpha.current = 1;
    for (let i = 0; i < iterations; i++) {
      step();
      alpha.current *= 0.985;
    }
    alpha.current = 0;
    setFrame((f) => f + 1);
  };

  const loop = () => {
    step();
    alpha.current *= 0.985;
    setFrame((f) => f + 1);
    raf.current = alpha.current > 0.03 ? requestAnimationFrame(loop) : 0;
  };

  const kick = () => {
    alpha.current = 1;
    if (!raf.current) raf.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const map = pos.current;
    let added = 0;
    for (const id of Object.keys(nodes)) {
      if (map.has(id)) continue;
      map.set(id, { x: W / 2 + (Math.random() - 0.5) * 120, y: H / 2 + (Math.random() - 0.5) * 100, vx: 0, vy: 0 });
      added++;
    }
    let removed = 0;
    for (const id of [...map.keys()]) {
      if (!nodes[id]) {
        map.delete(id);
        removed++;
      }
    }
    if (!map.size) {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      setFrame((f) => f + 1);
      return;
    }
    // A restored project (many nodes at once) or reduced motion settles in one go, like the prototype.
    if (reduced || added > 6) settle(420);
    else if (added || removed || drawn.length) kick();
  }, [nodes, drawn, reduced]);

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  const ids = Object.keys(nodes).filter((id) => pos.current.has(id));
  if (!ids.length) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Findings 與 entities 的關聯圖（目前沒有資料）">
        <text x={W / 2} y={H / 2} textAnchor="middle" style={{ fill: 'var(--ink-3)', fontSize: 12 }}>
          finding 進來後，關聯會在這裡長出來
        </text>
      </svg>
    );
  }

  const linked = new Set<string>();
  if (highlight) for (const e of drawn) if (e.to === highlight && e.type === 'mentions') linked.add(e.from);

  const fLabel = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 ? 'F' + (i + 1) : 'F?';
  };
  const ring = (id: string) => focusId === id;
  const focusHandlers = (id: string) => ({
    onFocus: (e: FocusEvent<SVGGElement>) => setFocusId(e.currentTarget.matches(':focus-visible') ? id : null),
    onBlur: () => setFocusId((cur) => (cur === id ? null : cur)),
  });

  // Entities first so finding nodes sit on top.
  const sorted = [...ids].sort((a, b) => (nodes[a].kind === nodes[b].kind ? 0 : nodes[a].kind === 'entity' ? -1 : 1));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Findings 與 entities 的關聯圖">
      {drawn.map((e, i) => {
        const a = pos.current.get(e.from);
        const b = pos.current.get(e.to);
        if (!a || !b) return null;
        const on = !!highlight && e.to === highlight;
        return (
          <line
            key={i}
            x1={a.x.toFixed(1)}
            y1={a.y.toFixed(1)}
            x2={b.x.toFixed(1)}
            y2={b.y.toFixed(1)}
            style={on ? { stroke: 'var(--live)', strokeWidth: 2 } : EDGE_STYLE[e.type] ?? EDGE_STYLE.mentions}
          />
        );
      })}
      {sorted.map((id) => {
        const n = nodes[id];
        const p = pos.current.get(id)!;
        if (n.kind === 'finding') {
          const on = linked.has(id);
          const label = fLabel(id);
          return (
            <g
              key={id}
              className="gn"
              role="button"
              tabIndex={0}
              aria-label={`${label}：${questions[id] ?? ''}，跳到卡片`}
              onClick={() => onFinding(id)}
              onKeyDown={onActivate(() => onFinding(id))}
              {...focusHandlers(id)}
            >
              {ring(id) ? (
                <rect x={(p.x - 18).toFixed(1)} y={(p.y - 14).toFixed(1)} width={36} height={28} rx={8} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 2 }} />
              ) : null}
              <rect
                x={(p.x - 14).toFixed(1)}
                y={(p.y - 10).toFixed(1)}
                width={28}
                height={20}
                rx={5}
                style={{ fill: on ? 'var(--live-soft)' : 'var(--accent-soft)', stroke: on ? 'var(--live)' : 'var(--accent)', strokeWidth: 1.2 }}
              />
              <text x={p.x.toFixed(1)} y={(p.y + 4).toFixed(1)} textAnchor="middle" style={{ fill: 'var(--accent)', font: '500 11px var(--font-mono)' }}>
                {label}
              </text>
            </g>
          );
        }
        const on = highlight === id;
        return (
          <g
            key={id}
            className="gn"
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${n.label}，標示相關卡片`}
            onClick={() => onEntity(id)}
            onKeyDown={onActivate(() => onEntity(id))}
            {...focusHandlers(id)}
          >
            {ring(id) ? <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={10.5} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 2 }} /> : null}
            <circle
              cx={p.x.toFixed(1)}
              cy={p.y.toFixed(1)}
              r={on ? 7 : 5.5}
              style={{ fill: on ? 'var(--live)' : 'var(--surface)', stroke: on ? 'var(--live)' : 'var(--ink-3)', strokeWidth: 1.4 }}
            />
            <text x={p.x.toFixed(1)} y={(p.y + 18).toFixed(1)} textAnchor="middle" style={{ fill: on ? 'var(--live)' : 'var(--ink-2)', fontSize: 10.5 }}>
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GraphLegend({ edges }: { edges: Edge[] }) {
  const has = (t: EdgeType) => edges.some((e) => e.type === t);
  return (
    <div className="legend">
      <span>
        <i />
        共同 entity
      </span>
      <span>
        <i className="sim" />
        語意相似
      </span>
      <span>
        <i className="con" />
        互相矛盾
      </span>
      {has('supports') ? (
        <span>
          <i className="sup" />
          互相支持
        </span>
      ) : null}
      {has('causes') ? (
        <span>
          <i className="cau" />
          因果關係
        </span>
      ) : null}
    </div>
  );
}
