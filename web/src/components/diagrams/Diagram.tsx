"use client";
import { useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { SPECS, type DNode } from "./specs";
import { useTerminal } from "../TerminalContext";
import { Button } from "../ui";

const NODE_H = 46;

function center(n: DNode) { return { cx: n.x + (n.w || 120) / 2, cy: n.y + (n.h || NODE_H) / 2 }; }
function anchor(from: DNode, to: DNode) {
  // point on from's border toward to's center
  const a = center(from), b = center(to);
  const w = (from.w || 120) / 2, h = (from.h || NODE_H) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  if (dx === 0 && dy === 0) return a;
  const sx = dx !== 0 ? w / Math.abs(dx) : Infinity, sy = dy !== 0 ? h / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { cx: a.cx + dx * s, cy: a.cy + dy * s };
}

export default function Diagram({ name }: { name: string }) {
  const spec = SPECS[name];
  const [sel, setSel] = useState<string | null>(null);
  const { run } = useTerminal();
  const byId = useMemo(() => Object.fromEntries((spec?.nodes || []).map((n) => [n.id, n])), [spec]);
  if (!spec) return null;
  const node = sel ? byId[sel] : null;
  const related = new Set(sel ? spec.edges.filter((e) => e.from === sel || e.to === sel).flatMap((e) => [e.from, e.to]) : []);
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2"><p className="text-sm font-semibold text-white">{spec.title}</p><span className="text-[11px] text-slate-500">interactive · click a node</span></div>
      <div className="grid lg:grid-cols-[1fr_280px]">
        <div className="overflow-x-auto p-3">
          <svg viewBox={`0 0 ${spec.width} ${spec.height}`} className="h-auto w-full min-w-[640px] select-none" role="img" aria-label={spec.title}>
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#64748b" /></marker>
              <marker id="arr-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#38bdf8" /></marker>
            </defs>
            {spec.groups.map((g) => (
              <g key={g.id}><rect x={g.x} y={g.y} width={g.w} height={g.h} rx={12} fill={g.color} fillOpacity={0.05} stroke={g.color} strokeOpacity={0.35} strokeDasharray="4 4" /><text x={g.x + 12} y={g.y + 18} fontSize={12} fill={g.color} fontWeight={600}>{g.label}</text></g>
            ))}
            {spec.edges.map((e, i) => {
              const f = byId[e.from], t = byId[e.to]; if (!f || !t) return null;
              const a = anchor(f, t), b = anchor(t, f);
              const hi = sel && (e.from === sel || e.to === sel);
              const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
              return (
                <g key={i} opacity={sel && !hi ? 0.25 : 1}>
                  <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke={hi ? "#38bdf8" : "#64748b"} strokeWidth={hi ? 2 : 1.3} strokeDasharray={e.dashed ? "5 4" : undefined} markerEnd={`url(#${hi ? "arr-hi" : "arr"})`} />
                  {e.label && <text x={mx} y={my - 4} fontSize={10} fill={hi ? "#7dd3fc" : "#94a3b8"} textAnchor="middle" style={{ paintOrder: "stroke" }} stroke="#0f172a" strokeWidth={3}>{e.label}</text>}
                </g>
              );
            })}
            {spec.nodes.map((n) => {
              const w = n.w || 120, h = n.h || NODE_H;
              const active = sel === n.id, dim = sel && !active && !related.has(n.id);
              return (
                <g key={n.id} onClick={() => setSel(active ? null : n.id)} className="cursor-pointer" opacity={dim ? 0.35 : 1}>
                  <rect x={n.x} y={n.y} width={w} height={h} rx={8} fill={active ? "#0c4a6e" : "#111827"} stroke={active ? "#38bdf8" : "#334155"} strokeWidth={active ? 2 : 1} />
                  <text x={n.x + w / 2} y={n.y + (n.sub ? 19 : 28)} fontSize={12.5} fontWeight={600} fill="#f1f5f9" textAnchor="middle">{n.label}</text>
                  {n.sub && <text x={n.x + w / 2} y={n.y + 35} fontSize={10} fill="#94a3b8" textAnchor="middle">{n.sub}</text>}
                </g>
              );
            })}
          </svg>
          {spec.legend && <p className="mt-2 text-xs text-slate-500">{spec.legend}</p>}
        </div>
        <aside className="border-t border-line p-4 lg:border-l lg:border-t-0">
          {node ? (
            <div>
              <div className="flex items-start justify-between"><h3 className="font-semibold text-white">{node.label}</h3><button onClick={() => setSel(null)} className="text-slate-500 hover:text-white"><X className="h-4 w-4" /></button></div>
              {node.sub && <p className="text-xs text-slate-400">{node.sub}</p>}
              <p className="mt-2 text-sm text-slate-300">{node.desc}</p>
              {node.cmd && (
                <div className="mt-3">
                  <pre className="overflow-x-auto rounded-md border border-line bg-[#0a0f1c] p-2 font-mono text-[11px] text-slate-200">{node.cmd}</pre>
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => run(node.cmd!)}><Play className="h-3.5 w-3.5" /> Run in terminal</Button>
                </div>
              )}
            </div>
          ) : <p className="text-sm text-slate-400">Select a component to read what it does, how it fails, and a command to inspect it live in your cluster.</p>}
        </aside>
      </div>
    </div>
  );
}
