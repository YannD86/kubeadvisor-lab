"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Crown, GraduationCap } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { ProductsResponse } from "@/lib/types";
import { fmtPrice } from "@/lib/utils";
import ProductCard from "@/components/ProductCard";
import { ErrorCard } from "@/components/Gate";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { Button, Empty } from "@/components/ui";

export default function CoursesPage() {
  const { user, entitled } = useAuth();
  const { auth_mode } = useMeta();
  const [data, setData] = useState<ProductsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.products.list().then((d) => { if (!stale) { setData(d); setErr(null); } }).catch((e) => { if (!stale) setErr(errorMessage(e)); });
    return () => { stale = true; };
  }, [user?.id]);

  const products = (data?.products || []).filter((p) => p.status !== "draft" || entitled("pro") || user?.role === "admin").sort((a, b) => a.order - b.order);
  const courses = products.filter((p) => p.kind !== "bundle");
  const bundles = products.filter((p) => p.kind === "bundle");
  const pro = data?.pro;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><GraduationCap className="h-4 w-4" /> Courses</p>
          <h1 className="mt-2 text-2xl font-bold text-white md:text-3xl">Structured paths, built on the same labs</h1>
          <p className="mt-2 max-w-3xl text-slate-300">Exam preparation, interview drills and production playbooks. Every course links back to the realms: lessons point at the scenarios and builders where you practice for real.</p>
        </div>
        {pro && auth_mode === "accounts" && !entitled("pro") && (
          <Link href="/pricing"><Button variant="secondary"><Crown className="h-4 w-4 text-amber-300" /> All courses with Pro · {fmtPrice(pro.price_cents, pro.currency)}/{pro.interval}</Button></Link>
        )}
      </header>
      {err && <ErrorCard message={`Cannot load the catalog: ${err}`} className="mb-4" />}
      {!data && !err && <p className="text-slate-400">Loading catalog…</p>}
      {data && products.length === 0 && <Empty title="No courses published yet">Content is added to <code>content/products/</code>; check back soon.</Empty>}
      {courses.length > 0 && (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((p) => <ProductCard key={p.id} p={p} />)}
        </section>
      )}
      {bundles.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Bundles</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{bundles.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </div>
  );
}
