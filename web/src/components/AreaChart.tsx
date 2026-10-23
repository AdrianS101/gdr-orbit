// Gráfico de área leve (SVG puro, sem biblioteca): curva suave, grade pontilhada e valor ao passar o mouse.
import { useMemo, useState } from 'react';

export function AreaChart({ points, height = 220, label, format = (v) => v.toLocaleString('pt-BR') }: { points: { x: string; y: number }[]; height?: number; label: string; format?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const pad = { l: 44, r: 12, t: 14, b: 26 };
  const max = Math.max(1, ...points.map((p) => p.y));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const X = (i: number) => pad.l + (i / Math.max(1, points.length - 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const path = useMemo(() => {
    if (!points.length) return '';
    // Catmull-Rom → Bézier (curva suave que passa pelos pontos)
    const pts = points.map((p, i) => [X(i), Y(p.y)]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(Y(0), p1[1] + (p2[1] - p0[1]) / 6)];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(Y(0), p2[1] - (p3[1] - p1[1]) / 6)];
      d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
    }
    return d;
  }, [points, top]); // eslint-disable-line react-hooks/exhaustive-deps
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => top * k);
  const every = Math.ceil(points.length / 8);
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="area-chart" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (points.length - 1)))));
        }}>
        <defs>
          <linearGradient id="ac-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--border)" strokeDasharray="2 6" />
            <text x={pad.l - 8} y={Y(t) + 4} textAnchor="end" className="ac-tick">{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % every === 0 || i === points.length - 1 ? <text key={p.x} x={X(i)} y={H - 6} textAnchor="middle" className="ac-tick">{p.x}</text> : null))}
        {path && <path d={`${path} L${X(points.length - 1)},${Y(0)} L${X(0)},${Y(0)} Z`} fill="url(#ac-fill)" />}
        {path && <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" className="ac-line" />}
        {h && hover !== null && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={Y(0)} stroke="var(--text-3)" strokeDasharray="3 3" />
            <circle cx={X(hover)} cy={Y(h.y)} r="5" fill="var(--accent)" stroke="var(--bg)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="ac-tip" style={{ left: `${(X(hover) / W) * 100}%` }}>
          <b>{format(h.y)}</b>
          <span>{h.x}</span>
        </div>
      )}
    </div>
  );
}

/** Cartão de indicador com variação × período anterior (como no exemplo do usuário). */
export function KpiCard({ label, cur, prev, icon }: { label: string; cur: number | null; prev: number | null; icon?: React.ReactNode }) {
  const delta = cur !== null && prev ? ((cur - prev) / prev) * 100 : null;
  return (
    <div className="kpi-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="kpi-ico">{icon}</span>
        <span className="muted small">{label}</span>
        <span className="spacer" />
        {delta !== null && <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1).replace('.', ',')}%</span>}
      </div>
      <div className="kpi-val">{cur === null ? '—' : cur.toLocaleString('pt-BR')}</div>
      <span className="faint small">{prev === null ? 'sem dados do período anterior' : `antes: ${prev.toLocaleString('pt-BR')}`}</span>
    </div>
  );
}
