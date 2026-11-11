import type {
  Builder, CheckResponse, ClusterStatus, EvalResult, Job, Lesson, LessonSummary, Progress, ProgressItem, Realm, Scenario, ScenarioSummary, Track, Category, AddonDef, BuilderSummary,
  Meta, AuthResponse, ProductsResponse, ProductDetail, CourseLesson, Assessment, AssessmentResult, Exercise, LabToken, LabTokenCreated, SyncStatus, Purchases,
} from "./types";

const BASE = typeof window === "undefined" ? (process.env.LAB_API_URL || "http://localhost:10201") : (process.env.NEXT_PUBLIC_API_URL || "");

/** Error detail shape used by the API: `{"detail": {"error": code, "message": ...}}` or `{"detail": "..."}`. */
export interface ErrorDetail { error?: string; message?: string; product?: string; missing?: string[] }

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : (detail as { message?: string })?.message || `HTTP ${status}`);
    this.name = "ApiError";
  }
  /** Contract error code (`payment_required`, `billing_disabled`, `lab_mode_hosted`, ...) or null. */
  get code(): string | null {
    const d = this.detail as ErrorDetail | string | undefined;
    return d && typeof d === "object" && typeof d.error === "string" ? d.error : null;
  }
  /** Extra field carried by some errors (402 → product id, 409 missing_addons → missing). */
  field<T = unknown>(name: string): T | undefined {
    const d = this.detail;
    return d && typeof d === "object" ? (d as Record<string, T>)[name] : undefined;
  }
}

export function isApiError(e: unknown): e is ApiError { return e instanceof ApiError; }
export function errorCode(e: unknown): string | null { return isApiError(e) ? e.code : null; }
export function errorStatus(e: unknown): number { return isApiError(e) ? e.status : 0; }
export function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers || {}) }, cache: "no-store" });
  } catch {
    throw new ApiError(0, { error: "unreachable", message: "Cannot reach the API" });
  }
  if (!res.ok) {
    let detail: unknown = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body;
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // ---- platform meta / identity
  meta: () => req<Meta>("/api/meta"),
  auth: {
    signup: (email: string, password: string, name?: string) => req<AuthResponse>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
    login: (email: string, password: string) => req<AuthResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
    me: () => req<AuthResponse>("/api/auth/me"),
  },
  // ---- storefront
  products: {
    list: () => req<ProductsResponse>("/api/products"),
    get: (id: string) => req<ProductDetail>(`/api/products/${encodeURIComponent(id)}`),
  },
  courses: {
    lesson: (product: string, slug: string) => req<CourseLesson>(`/api/courses/${encodeURIComponent(product)}/lessons/${encodeURIComponent(slug)}`),
    assessment: (product: string, id: string) => req<Assessment>(`/api/courses/${encodeURIComponent(product)}/assessments/${encodeURIComponent(id)}`),
    submitAssessment: (product: string, id: string, answers: Record<string, number>) => req<AssessmentResult>(`/api/courses/${encodeURIComponent(product)}/assessments/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify({ answers }) }),
    exercise: (product: string, id: string) => req<Exercise>(`/api/courses/${encodeURIComponent(product)}/exercises/${encodeURIComponent(id)}`),
  },
  labTokens: {
    list: () => req<{ tokens: LabToken[] }>("/api/lab-tokens"),
    create: (name: string) => req<LabTokenCreated>("/api/lab-tokens", { method: "POST", body: JSON.stringify({ name }) }),
    remove: (id: string) => req<{ ok: boolean }>(`/api/lab-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  sync: {
    status: () => req<SyncStatus>("/api/sync/status"),
  },
  billing: {
    checkout: (product: string) => req<{ url: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify({ product }) }),
    portal: () => req<{ url: string }>("/api/billing/portal"),
    purchases: () => req<Purchases>("/api/billing/purchases"),
  },

  // ---- lab engine (unchanged)
  realms: () => req<{ realms: Realm[]; tracks: Track[]; categories: Category[]; addons: AddonDef[] }>("/api/realms"),
  realm: (id: string) => req<Realm & { lessons?: LessonSummary[]; builders?: BuilderSummary[]; scenarios?: ScenarioSummary[]; tracks?: Track[]; categories?: Category[] }>(`/api/realms/${id}`),
  builders: () => req<{ builders: BuilderSummary[]; tracks: Track[] }>("/api/builders"),
  builder: (id: string) => req<Builder>(`/api/builders/${id}`),
  evaluate: (id: string, yaml: string) => req<EvalResult>(`/api/builders/${id}/evaluate`, { method: "POST", body: JSON.stringify({ yaml }) }),
  lint: (id: string, yaml: string) => req<{ available: boolean; ok: boolean | null; output: string }>(`/api/builders/${id}/lint`, { method: "POST", body: JSON.stringify({ yaml }) }),
  applyManifest: (id: string, yaml: string) => req<{ ok: boolean; output: string; mode?: string }>(`/api/builders/${id}/apply`, { method: "POST", body: JSON.stringify({ yaml }) }),
  lessons: (realm: string) => req<{ realm: Realm; lessons: LessonSummary[] }>(`/api/lessons/${realm}`),
  lesson: (realm: string, slug: string) => req<Lesson>(`/api/lessons/${realm}/${slug}`),
  scenarios: () => req<{ scenarios: ScenarioSummary[]; categories: Category[] }>("/api/scenarios"),
  scenario: (id: string) => req<Scenario>(`/api/scenarios/${id}`),
  loadScenario: (id: string) => req<Job>(`/api/scenarios/${id}/load`, { method: "POST" }),
  cleanupScenario: (id: string) => req<Job>(`/api/scenarios/${id}/cleanup`, { method: "POST" }),
  resetScenario: (id: string) => req<Job>(`/api/scenarios/${id}/reset`, { method: "POST" }),
  checkScenario: (id: string) => req<CheckResponse>(`/api/scenarios/${id}/check`, { method: "POST" }),
  hint: (id: string, index: number) => req<{ index: number; hint: string; hints_revealed: number; total: number }>(`/api/scenarios/${id}/hint?index=${index}`, { method: "POST" }),
  solution: (id: string) => req<{ markdown: string }>(`/api/scenarios/${id}/solution`),
  clusterStatus: () => req<ClusterStatus>("/api/cluster/status"),
  tools: () => req<Record<string, string | null>>("/api/cluster/tools"),
  clusterUp: () => req<Job>("/api/cluster/up", { method: "POST" }),
  clusterDown: () => req<Job>("/api/cluster/down", { method: "POST" }),
  resetLabs: () => req<Job>("/api/cluster/reset-labs", { method: "POST" }),
  installAddon: (id: string) => req<Job>(`/api/cluster/addons/${id}`, { method: "POST" }),
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  progress: () => req<Progress>("/api/progress"),
  setProgress: (kind: string, item_id: string, status: string, data: Record<string, unknown> = {}) => req<ProgressItem>(`/api/progress`, { method: "POST", body: JSON.stringify({ kind, item_id, status, data }) }),
  resetProgress: () => req("/api/progress", { method: "DELETE" }),
};

export function wsUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_WS_URL || (typeof window !== "undefined" ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:10201` : "ws://localhost:10201");
  return `${base}${path}`;
}
