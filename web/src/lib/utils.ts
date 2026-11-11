import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export const DIFF_COLOR: Record<string, string> = {
  beginner: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  intermediate: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  advanced: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export const REALM_CLASS: Record<string, string> = {
  violet: "realm-violet", sky: "realm-sky", emerald: "realm-emerald", amber: "realm-amber", rose: "realm-rose",
};

export function realmHref(r: { id: string; kind: string }): string {
  if (r.kind === "builders") return "/build";
  if (r.kind === "scenarios") return "/scenarios";
  return `/learn/${r.id}`;
}

export function fmtAgo(ts?: number | null): string {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "$199" / "$19.50" / "€49" from cents + ISO currency. */
export function fmtPrice(cents: number | null | undefined, currency = "usd"): string {
  if (cents == null) return "";
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency.toUpperCase()}`;
  }
}

/** Only allow same-site relative redirects for `?next=`. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("://")) return fallback;
  return next;
}

export function fmtDate(ts?: number | null): string {
  if (!ts) return "";
  try { return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return ""; }
}

export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Link target for a progress item, by kind. */
export function progressHref(i: { kind: string; item_id: string }): string {
  const id = String(i.item_id);
  if (i.kind === "builder") return `/build/${id}`;
  if (i.kind === "scenario") return `/scenarios/${id}`;
  if (i.kind === "course_lesson") return `/courses/${id}`;
  if (i.kind === "exercise") { const [p, ...rest] = id.split("/"); return `/courses/${p}/exercises/${rest.join("/")}`; }
  if (i.kind === "assessment") { const [p, ...rest] = id.split("/"); return `/courses/${p}/assessments/${rest.join("/")}`; }
  return `/learn/${id}`;
}

export const EXAM_DISCLAIMER = "CKA® and CKAD® are trademarks of The Linux Foundation. This course is independent exam preparation and is not affiliated with or endorsed by the Linux Foundation or CNCF.";
