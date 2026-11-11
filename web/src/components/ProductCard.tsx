"use client";
import Link from "next/link";
import { CheckCircle2, Clock, Crown, Layers, Package } from "lucide-react";
import type { ProductSummary } from "@/lib/types";
import { DIFF_COLOR, cn, fmtPrice } from "@/lib/utils";
import { Badge, Card } from "./ui";

/** Price / ownership label used by catalog cards and the product page. */
export function OwnershipLabel({ p, className }: { p: ProductSummary; className?: string }) {
  if (p.owned && p.via === "pro") return <span className={cn("inline-flex items-center gap-1 text-sm font-medium text-amber-200", className)}><Crown className="h-3.5 w-3.5" /> Included in Pro</span>;
  if (p.owned) return <span className={cn("inline-flex items-center gap-1 text-sm font-medium text-emerald-300", className)}><CheckCircle2 className="h-3.5 w-3.5" /> Owned ✓</span>;
  return <span className={cn("text-sm font-semibold text-white", className)}>{fmtPrice(p.price_cents, p.currency)}<span className="ml-1 text-[11px] font-normal text-slate-500">or Pro</span></span>;
}

export default function ProductCard({ p, className }: { p: ProductSummary; className?: string }) {
  return (
    <Link href={`/courses/${p.id}`} className="block h-full">
      <Card className={cn("flex h-full flex-col p-4 transition-colors hover:border-sky-400/50", className)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">{p.kind === "bundle" ? <><Package className="h-3 w-3" /> bundle</> : "course"}{p.featured && <span className="rounded bg-sky-500/15 px-1 py-px text-[10px] normal-case tracking-normal text-sky-200">featured</span>}</p>
            <h3 className="mt-0.5 font-semibold text-white">{p.title}</h3>
          </div>
          <OwnershipLabel p={p} className="shrink-0 text-right" />
        </div>
        <p className="mt-2 line-clamp-3 text-sm text-slate-400">{p.tagline}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          {p.difficulty && <Badge className={DIFF_COLOR[p.difficulty] || "border-slate-600 text-slate-300"}>{p.difficulty}</Badge>}
          {p.duration_hours > 0 && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {p.duration_hours} h</span>}
          {p.kind === "bundle" && p.includes?.length > 0 && <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" /> Includes {p.includes.length} course{p.includes.length > 1 ? "s" : ""}</span>}
          <span>{p.lesson_count} lesson{p.lesson_count === 1 ? "" : "s"}</span>
          {p.assessment_count > 0 && <span>· {p.assessment_count} assessment{p.assessment_count === 1 ? "" : "s"}</span>}
          {p.exercise_count > 0 && <span>· {p.exercise_count} exercise{p.exercise_count === 1 ? "" : "s"}</span>}
        </div>
        {p.owned && (
          <div className="mt-auto pt-3">
            <div className="flex items-center justify-between text-[11px] text-slate-400"><span>progress</span><span className="font-mono">{Math.round(p.progress_percent || 0)}%</span></div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.min(100, Math.max(0, p.progress_percent || 0))}%` }} /></div>
          </div>
        )}
      </Card>
    </Link>
  );
}
