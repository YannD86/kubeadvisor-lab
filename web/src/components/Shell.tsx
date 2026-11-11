"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, Braces, ChevronDown, Cpu, Crown, GitBranch, GraduationCap, Home, Laptop, Lock, LogIn, LogOut, Server, Stethoscope, Tag, TerminalSquare, UserCircle } from "lucide-react";
import { cn, realmHref } from "@/lib/utils";
import { api } from "@/lib/api";
import type { Realm } from "@/lib/types";
import ClusterPill from "./ClusterPill";
import TerminalDrawer from "./TerminalDrawer";
import { TerminalProvider } from "./TerminalContext";
import { useAuth, useMeta } from "./PlatformContext";
import { Badge } from "./ui";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; color?: string; exact?: boolean };

const TOP: NavItem[] = [
  { href: "/", label: "Home", icon: Home, exact: true },
  { href: "/courses", label: "Courses", icon: GraduationCap, color: "text-sky-300" },
];
const NAV: NavItem[] = [
  { href: "/build", label: "Manifests & CRDs", icon: Braces, color: "text-violet-300" },
  { href: "/learn/gitops", label: "GitOps: Flux & Helm", icon: GitBranch, color: "text-sky-300" },
  { href: "/learn/components", label: "Components", icon: Cpu, color: "text-emerald-300" },
  { href: "/scenarios", label: "Scenarios", icon: TerminalSquare, color: "text-amber-300" },
  { href: "/learn/troubleshooting", label: "Troubleshooting", icon: Stethoscope, color: "text-rose-300" },
];
const SYS: NavItem[] = [
  { href: "/cluster", label: "Cluster", icon: Server },
  { href: "/progress", label: "Progress", icon: Activity },
];
const PLATFORM: NavItem[] = [
  { href: "/pricing", label: "Pricing", icon: Tag },
  { href: "/account", label: "Account", icon: UserCircle },
];

function UserMenu() {
  const { auth_mode, loaded } = useMeta();
  const { user, loading, logout } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!loaded) return null;
  if (auth_mode === "local") {
    return <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200" title="auth_mode=local: single local admin user"><Laptop className="mr-1 h-3 w-3" /> Local runner</Badge>;
  }
  if (loading) return <span className="h-7 w-7 animate-pulse rounded-full bg-slate-800" />;
  if (!user) {
    return (
      <Link href={`/login?next=${encodeURIComponent(path || "/")}`} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-sky-500 px-2.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"><LogIn className="h-3.5 w-3.5" /> Sign in</Link>
    );
  }
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  const isPro = user.tier === "pro";
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 py-0.5 pl-0.5 pr-2 text-xs text-slate-200 hover:bg-slate-800" aria-haspopup="menu" aria-expanded={open}>
        <span className={cn("grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold", isPro ? "bg-amber-500/20 text-amber-200" : "bg-sky-500/20 text-sky-200")}>{initial}</span>
        <span className="hidden max-w-[120px] truncate sm:inline">{user.name || user.email}</span>
        {isPro && <Crown className="h-3 w-3 text-amber-300" />}
        <ChevronDown className="h-3 w-3 text-slate-500" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1.5 w-60 overflow-hidden rounded-lg border border-slate-700 bg-[#0f172a] shadow-xl">
          <div className="border-b border-slate-800 px-3 py-2.5">
            <p className="truncate text-sm font-medium text-white">{user.name || user.email}</p>
            {user.name && <p className="truncate text-xs text-slate-400">{user.email}</p>}
            <div className="mt-1.5 flex items-center gap-1.5">
              <Badge className={isPro ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-600 text-slate-300"}>{isPro ? <><Crown className="mr-1 h-3 w-3" /> Pro</> : "Free"}</Badge>
              {user.role === "admin" && <Badge className="border-rose-500/40 bg-rose-500/10 text-rose-200">admin</Badge>}
            </div>
          </div>
          <Link href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"><UserCircle className="h-4 w-4 text-slate-400" /> Account</Link>
          {!isPro && <Link href="/pricing" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"><Crown className="h-4 w-4 text-amber-300" /> Get Pro</Link>}
          <button onClick={async () => { setOpen(false); await logout(); router.push("/"); router.refresh(); }} className="flex w-full items-center gap-2 border-t border-slate-800 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"><LogOut className="h-4 w-4 text-slate-400" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const meta = useMeta();
  const { entitled, user } = useAuth();
  const [realms, setRealms] = useState<Realm[]>([]);
  useEffect(() => {
    let stale = false;
    api.realms().then((r) => { if (!stale) setRealms(r.realms); }).catch(() => null);
    return () => { stale = true; };
  }, [user?.id]);

  const active = (href: string, exact?: boolean) => (exact ? path === href : path === href || path.startsWith(href + "/"));
  /** Pro lock next to a realm the current user cannot open (accounts mode only). */
  const lockedFor = (href: string) => {
    if (meta.auth_mode !== "accounts" || entitled("pro")) return false;
    const r = realms.find((x) => realmHref(x) === href);
    return !!r && (r.access === "pro" || r.locked === true);
  };
  const Item = ({ href, label, icon: Icon, color, exact }: NavItem) => (
    <Link href={href} className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-300 hover:bg-slate-800/80", active(href, exact) && "bg-slate-800 text-white")}>
      <Icon className={cn("h-4 w-4", color || "text-slate-400")} /><span className="truncate">{label}</span>
      {lockedFor(href) && <span title="Pro realm" className="ml-auto inline-flex items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-200"><Lock className="h-2.5 w-2.5" /> Pro</span>}
    </Link>
  );
  const platformItems = PLATFORM.filter((n) => n.href !== "/pricing" || meta.auth_mode === "accounts" || !meta.loaded);
  return (
    <TerminalProvider>
      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-[#0a0e19] md:flex">
          <Link href="/" className="flex items-center gap-2 px-4 py-4">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/15 text-sky-300"><Server className="h-4 w-4" /></span>
            <div className="leading-tight"><p className="text-sm font-semibold text-white">KubeAdvisor</p><p className="text-[11px] text-slate-500">Kubernetes, the SRE way</p></div>
          </Link>
          <nav className="flex flex-1 flex-col gap-0.5 px-2">
            {TOP.map((n) => <Item key={n.href} {...n} />)}
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Realms</p>
            {NAV.map((n) => <Item key={n.href} {...n} />)}
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Lab</p>
            {SYS.map((n) => <Item key={n.href} {...n} />)}
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Platform</p>
            {platformItems.map((n) => <Item key={n.href} {...n} />)}
          </nav>
          <div className="border-t border-line p-3 text-[11px] text-slate-500">
            kind · Calico · Flux · Helm · k9s<br />
            {meta.loaded ? <>{meta.auth_mode} · {meta.lab_mode}{meta.version ? ` · v${meta.version}` : ""}</> : <>web :10200 · api :10201</>}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:px-6">
            <div className="flex items-center gap-3 md:hidden"><Link href="/" className="text-sm font-semibold text-white">KubeAdvisor</Link></div>
            <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto text-xs text-slate-400 md:flex">
              {[TOP[1], ...NAV].map((n) => <Link key={n.href} href={n.href} className={cn("whitespace-nowrap rounded px-2 py-1 hover:text-white", active(n.href) && "text-white")}>{n.label}</Link>)}
            </nav>
            <div className="flex shrink-0 items-center gap-2">
              <ClusterPill />
              <UserMenu />
            </div>
          </header>
          <main className="flex-1 px-4 py-6 pb-24 md:px-8">{children}</main>
        </div>
      </div>
      <TerminalDrawer />
    </TerminalProvider>
  );
}
