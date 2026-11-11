"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { AuthResponse, Entitlements, Meta, User } from "@/lib/types";

/** Defaults used until `GET /api/meta` answers (or when it is missing on an older API): behave as the local runner. */
export const DEFAULT_META: Meta = { product: "KubeAdvisor", version: "", auth_mode: "local", lab_mode: "local", billing_enabled: false, signup_enabled: false };
const ANON: Entitlements = { pro: false, products: [], admin: false };

/** GET /api/auth/me; a 401 (anonymous) is not an error, and neither is an unreachable API: both mean "no user". */
async function fetchMe(): Promise<AuthResponse | null> {
  try { return await api.auth.me(); } catch { return null; }
}

export interface MetaCtx extends Meta {
  /** true once /api/meta answered (ok or error). */
  loaded: boolean;
  /** set when /api/meta could not be fetched (API unreachable or route missing). */
  error: string | null;
}

export interface AuthCtx {
  user: User | null;
  entitlements: Entitlements;
  /** true while the first /api/auth/me is in flight. */
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string, name?: string) => Promise<User>;
  logout: () => Promise<void>;
  /** entitlement check: `entitled("pro")` or `entitled("<product-id>")`. Admins and Pro are entitled to everything. */
  entitled: (product: string) => boolean;
}

const MetaContext = createContext<MetaCtx>({ ...DEFAULT_META, loaded: false, error: null });
const AuthContext = createContext<AuthCtx>({
  user: null, entitlements: ANON, loading: true,
  refresh: async () => {}, login: async () => { throw new Error("auth unavailable"); }, signup: async () => { throw new Error("auth unavailable"); }, logout: async () => {},
  entitled: () => false,
});

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<MetaCtx>({ ...DEFAULT_META, loaded: false, error: null });
  const [user, setUser] = useState<User | null>(null);
  const [ents, setEnts] = useState<Entitlements>(ANON);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api.meta()
      .then((m) => { if (alive.current) setMeta({ ...DEFAULT_META, ...m, loaded: true, error: null }); })
      .catch((e) => { if (alive.current) setMeta({ ...DEFAULT_META, loaded: true, error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive.current = false; };
  }, []);

  // apply a /api/auth/me answer; null = anonymous (401), unreachable API, or an older API without the route
  const apply = useCallback((r: AuthResponse | null) => {
    if (!alive.current) return;
    setUser(r?.user ?? null); setEnts(r?.entitlements ?? ANON); setLoading(false);
  }, []);
  const refresh = useCallback(() => fetchMe().then(apply), [apply]);
  useEffect(() => { fetchMe().then(apply); }, [apply]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.auth.login(email, password);
    setUser(r.user); setEnts(r.entitlements || ANON); setLoading(false);
    return r.user;
  }, []);
  const signup = useCallback(async (email: string, password: string, name?: string) => {
    const r = await api.auth.signup(email, password, name);
    setUser(r.user); setEnts(r.entitlements || ANON); setLoading(false);
    return r.user;
  }, []);
  const logout = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* cookie may already be gone */ }
    setUser(null); setEnts(ANON);
  }, []);
  const entitled = useCallback((product: string) => {
    if (ents.admin || ents.pro) return true;
    if (product === "pro") return false;
    return ents.products.includes(product);
  }, [ents]);

  const authValue = useMemo<AuthCtx>(() => ({ user, entitlements: ents, loading, refresh, login, signup, logout, entitled }), [user, ents, loading, refresh, login, signup, logout, entitled]);

  return (
    <MetaContext.Provider value={meta}>
      <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
    </MetaContext.Provider>
  );
}

export function useMeta(): MetaCtx { return useContext(MetaContext); }
export function useAuth(): AuthCtx { return useContext(AuthContext); }
