"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Crown, Minus, Tag, UserPlus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { ProductsResponse } from "@/lib/types";
import { cn, fmtPrice } from "@/lib/utils";
import ProductCard from "@/components/ProductCard";
import { ErrorCard } from "@/components/Gate";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { BILLING_TOOLTIP, useCheckout } from "@/components/useCheckout";
import { Badge, Button, Card, Spinner } from "@/components/ui";

const ROWS: { label: string; free: boolean | string; pro: boolean | string }[] = [
  { label: "Manifest & CRD builders (19 guided activities)", free: true, pro: true },
  { label: "Realm lessons: GitOps, Components, Troubleshooting method", free: true, pro: true },
  { label: "Course previews (first lesson of every course)", free: true, pro: true },
  { label: "Local runner: kind cluster, web terminal, k9s", free: true, pro: true },
  { label: "Loaded troubleshooting scenarios (28, with checks and solutions)", free: false, pro: true },
  { label: "All courses: CKA / CKAD exam prep, interviews, production playbook", free: "buy individually", pro: true },
  { label: "Assessments with per-domain scoring", free: "owned courses", pro: true },
  { label: "Progress synced between runner and platform", free: true, pro: true },
];

function Cell({ v }: { v: boolean | string }) {
  if (v === true) return <Check className="mx-auto h-4 w-4 text-emerald-400" />;
  if (v === false) return <Minus className="mx-auto h-4 w-4 text-slate-600" />;
  return <span className="text-xs text-slate-400">{v}</span>;
}

export default function PricingPage() {
  const { auth_mode, loaded } = useMeta();
  const { user, entitled } = useAuth();
  const { checkout, busy, notice, billingEnabled, anonymous } = useCheckout();
  const [data, setData] = useState<ProductsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.products.list().then((d) => { if (!stale) { setData(d); setErr(null); } }).catch((e) => { if (!stale) setErr(errorMessage(e)); });
    return () => { stale = true; };
  }, [user?.id]);

  const pro = data?.pro;
  const proPrice = pro ? fmtPrice(pro.price_cents, pro.currency) : null;
  const hasPro = entitled("pro");
  const products = (data?.products || []).filter((p) => p.status !== "draft").sort((a, b) => a.order - b.order);
  const canBuy = billingEnabled && (pro?.enabled ?? true);

  const renderProCta = () => {
    if (loaded && auth_mode === "local") return <p className="text-xs text-slate-400">This is a local runner. Plans are managed on the KubeAdvisor platform account you sync to.</p>;
    if (hasPro) return <Link href="/account"><Button variant="secondary" className="w-full"><Crown className="h-4 w-4 text-amber-300" /> You are on Pro · manage billing</Button></Link>;
    if (anonymous) return <Link href="/signup?next=/pricing"><Button className="w-full"><UserPlus className="h-4 w-4" /> Create a free account to get Pro</Button></Link>;
    return (
      <span title={!canBuy ? BILLING_TOOLTIP : undefined} className="block">
        <Button className="w-full" onClick={() => checkout("pro")} disabled={!canBuy || busy !== null}>{busy === "pro" ? <Spinner /> : <Crown className="h-4 w-4" />} Get Pro{proPrice ? ` · ${proPrice}/${pro?.interval}` : ""}</Button>
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><Tag className="h-4 w-4" /> Pricing</p>
        <h1 className="mt-2 text-2xl font-bold text-white md:text-3xl">Free to build. Pro to break things.</h1>
        <p className="mt-2 max-w-3xl text-slate-300">The builders and realm lessons are free forever. Pro unlocks the loaded scenarios and every course; individual courses can also be bought outright.</p>
      </header>
      {err && <ErrorCard message={`Cannot load prices: ${err}`} className="mb-4" />}
      {!canBuy && loaded && auth_mode === "accounts" && !hasPro && <p className="mb-4 rounded-md border border-slate-700 bg-slate-800/50 p-3 text-sm text-slate-300">{BILLING_TOOLTIP}. You can browse everything; purchases are not enabled on this instance yet.</p>}
      {notice && <p className={cn("mb-4 rounded-md border p-2.5 text-sm", notice.kind === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-100" : "border-slate-600 bg-slate-800/60 text-slate-200")}>{notice.text}{notice.note && <span className="block text-xs text-slate-400">{notice.note}</span>}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden">
          <table className="table-plain">
            <thead>
              <tr><th className="w-1/2">What you get</th><th className="text-center">Free</th><th className="text-center"><span className="inline-flex items-center gap-1 text-amber-200"><Crown className="h-3.5 w-3.5" /> Pro</span></th></tr>
            </thead>
            <tbody>
              {ROWS.map((r) => <tr key={r.label}><td className="text-slate-200">{r.label}</td><td className="text-center"><Cell v={r.free} /></td><td className="text-center"><Cell v={r.pro} /></td></tr>)}
              <tr>
                <td className="text-slate-400">Price</td>
                <td className="text-center text-sm font-semibold text-white">$0</td>
                <td className="text-center text-sm font-semibold text-white">{proPrice ? <>{proPrice}<span className="text-xs font-normal text-slate-400">/{pro?.interval}</span></> : "—"}</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <div className="space-y-3">
          <Card className="border-amber-500/30 bg-amber-500/5 p-5">
            <div className="flex items-center justify-between"><p className="flex items-center gap-2 text-sm font-semibold text-white"><Crown className="h-4 w-4 text-amber-300" /> KubeAdvisor Pro</p>{hasPro && <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">active</Badge>}</div>
            <p className="mt-2 text-3xl font-bold text-white">{proPrice || "—"}<span className="text-sm font-normal text-slate-400">{pro ? `/${pro.interval}` : ""}</span></p>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-200">
              {["Every loaded scenario, checks and solutions", "Every course, assessment and exercise", "New scenarios and courses as they ship", "Cancel any time from the billing portal"].map((t) => <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {t}</li>)}
            </ul>
            <div className="mt-4">{renderProCta()}</div>
          </Card>
          <Card className="p-5">
            <p className="text-sm font-semibold text-white">Free</p>
            <p className="mt-1 text-sm text-slate-400">Builders, realm lessons and course previews. No card needed.</p>
            {anonymous && <Link href="/signup?next=/pricing" className="mt-3 block"><Button variant="outline" className="w-full"><UserPlus className="h-4 w-4" /> Create a free account</Button></Link>}
          </Card>
        </div>
      </div>

      {products.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Or buy a course outright</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{products.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </div>
  );
}
