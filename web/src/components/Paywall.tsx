"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Crown, Lock, LogIn, ShoppingCart } from "lucide-react";
import { api } from "@/lib/api";
import type { ProPlan } from "@/lib/types";
import { cn, fmtPrice } from "@/lib/utils";
import { useAuth, useMeta } from "./PlatformContext";
import { Button, Card, Spinner } from "./ui";
import { BILLING_TOOLTIP, useCheckout } from "./useCheckout";

interface Info { title: string; price: string | null; kind: "course" | "bundle" | "pro" }

/**
 * Locked-content card (402 `payment_required`). `product` is a product id or `"pro"`.
 * Shows product title + price, "Buy course" + "Get Pro"; anonymous users get "Sign in".
 */
export default function Paywall({ product, message, className }: { product: string; message?: string; className?: string }) {
  const { auth_mode } = useMeta();
  const { user } = useAuth();
  const { checkout, busy, notice, billingEnabled, anonymous, loginHref, signupHref } = useCheckout();
  const [info, setInfo] = useState<Info | null>(null);
  const [pro, setPro] = useState<ProPlan | null>(null);

  const isPro = product === "pro";
  useEffect(() => {
    let stale = false;
    api.products.list().then((r) => { if (!stale) setPro(r.pro); }).catch(() => null);
    if (!isPro) {
      api.products.get(product)
        .then((p) => { if (!stale) setInfo({ title: p.title, price: fmtPrice(p.price_cents, p.currency), kind: p.kind }); })
        .catch(() => { if (!stale) setInfo({ title: product, price: null, kind: "course" }); });
    }
    return () => { stale = true; };
  }, [product, isPro]);

  const proPrice = pro ? `${fmtPrice(pro.price_cents, pro.currency)}/${pro.interval}` : null;
  const shown: Info | null = isPro ? { title: "KubeAdvisor Pro", price: null, kind: "pro" } : info && info.title !== undefined ? info : null;

  return (
    <Card className={cn("border-amber-500/30 bg-amber-500/5 p-5", className)}>
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-amber-300"><Lock className="h-4 w-4" /> {isPro ? "Pro content" : "Locked"}</p>
      <h2 className="mt-2 text-lg font-semibold text-white">{shown ? shown.title : <span className="inline-flex items-center gap-2 text-slate-300"><Spinner /> loading…</span>}</h2>
      <p className="mt-1 text-sm text-slate-300">
        {message || (isPro
          ? "Loaded scenarios, all courses and every realm are part of KubeAdvisor Pro."
          : "This lesson is part of a paid course. Buy the course once, or get Pro for everything.")}
      </p>
      {auth_mode === "local" ? (
        <p className="mt-3 text-xs text-slate-500">This runner is in local mode: entitlements are managed on the platform account you sync to.</p>
      ) : anonymous ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link href={loginHref}><Button><LogIn className="h-4 w-4" /> Sign in</Button></Link>
          <Link href={signupHref}><Button variant="outline">Create account</Button></Link>
          <span className="text-xs text-slate-500">Already bought it? Sign in to unlock.</span>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!isPro && (
            <Button onClick={() => checkout(product)} disabled={busy !== null} title={!billingEnabled ? BILLING_TOOLTIP : undefined}>
              {busy === product ? <Spinner /> : <ShoppingCart className="h-4 w-4" />} {shown?.kind === "bundle" ? "Buy bundle" : "Buy course"}{shown?.price ? ` · ${shown.price}` : ""}
            </Button>
          )}
          <Button variant={isPro ? "primary" : "secondary"} onClick={() => checkout("pro")} disabled={busy !== null} title={!billingEnabled ? BILLING_TOOLTIP : undefined}>
            {busy === "pro" ? <Spinner /> : <Crown className="h-4 w-4 text-amber-300" />} Get Pro{proPrice ? ` · ${proPrice}` : ""}
          </Button>
          <Link href="/pricing" className="text-xs text-sky-300 hover:underline">Compare plans</Link>
          {user?.tier === "pro" && <span className="text-xs text-emerald-300">You are on Pro; refresh if this just changed.</span>}
        </div>
      )}
      {!billingEnabled && auth_mode === "accounts" && !anonymous && <p className="mt-3 text-xs text-slate-500">{BILLING_TOOLTIP}. Purchases are not enabled on this instance yet.</p>}
      {notice && <p className={cn("mt-3 rounded-md border p-2.5 text-sm", notice.kind === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-100" : "border-slate-600 bg-slate-800/60 text-slate-200")}>{notice.text}{notice.note && <span className="block text-xs text-slate-400">{notice.note}</span>}</p>}
    </Card>
  );
}
