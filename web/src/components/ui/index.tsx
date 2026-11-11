"use client";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export function Button({ className, variant = "primary", size = "md", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg" }) {
  const v: Record<BtnVariant, string> = {
    primary: "bg-sky-500 text-slate-950 hover:bg-sky-400 font-semibold",
    secondary: "bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700",
    outline: "border border-slate-600 text-slate-200 hover:bg-slate-800",
    ghost: "text-slate-300 hover:bg-slate-800",
    danger: "bg-rose-600/90 text-white hover:bg-rose-500",
  };
  const s = { sm: "h-7 px-2.5 text-xs gap-1.5", md: "h-9 px-3.5 text-sm gap-2", lg: "h-11 px-5 text-base gap-2" }[size];
  return <button className={cn("inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap", v[variant], s, className)} {...props} />;
}

export function Badge({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", className)} {...props}>{children}</span>;
}

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-line bg-panel", className)} {...props}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <svg className={cn("animate-spin h-4 w-4", className)} viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center"><p className="font-medium text-slate-200">{title}</p>{children && <div className="mt-2 text-sm text-slate-400">{children}</div>}</div>;
}

export function Dot({ ok, pulse }: { ok: boolean | null; pulse?: boolean }) {
  return <span className={cn("inline-block h-2 w-2 rounded-full", ok === null ? "bg-slate-500" : ok ? "bg-emerald-400" : "bg-rose-400", pulse && "pulse")} />;
}
