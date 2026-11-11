export type RealmKind = "builders" | "lessons" | "scenarios";
export interface Realm { id: string; title: string; tagline: string; icon: string; color: string; kind: RealmKind; order: number; description: string; item_count: number; access?: "free" | "pro"; locked?: boolean }
export interface Track { id: string; title: string }
export interface Category { id: string; title: string; description: string }
export interface AddonDef { id: string; title: string; description: string }

export interface BuilderSummary { id: string; title: string; kind: string; apiVersion: string; track: string; difficulty: string; estimated_minutes: number; summary: string; crd?: boolean; step_count: number; prerequisites?: string[]; docs_url?: string; }
export interface Expect { type: string; value?: unknown }
export interface Step { path: string; title: string; prompt: string; why: string; hint: string; expect: Expect; reveal: string; gotchas?: string[] }
export interface QuizQ { q: string; options: string[]; answer: number; explain: string }
export interface Builder extends BuilderSummary { intro: string; steps: Step[]; final_manifest: string; apply?: { mode: string; requires_addons?: string[] }; quiz?: QuizQ[] }
export interface StepResult { index: number; path: string; status: "pass" | "fail" | "missing" | "unknown"; message: string }
export interface EvalResult { parse_ok: boolean; error: string | null; steps: StepResult[]; passed: number; total: number; complete: boolean }

export interface LessonSummary { title: string; slug: string; realm: string; order: number; summary: string; estimated_minutes: number; level: string; tags?: string[]; builders?: string[]; scenarios?: string[]; diagram?: string; word_count: number; quiz_count: number }
export interface Lesson extends LessonSummary { body: string; quiz?: QuizQ[]; prev: { slug: string; title: string } | null; next: { slug: string; title: string } | null; builder_items: BuilderSummary[]; scenario_items: ScenarioSummary[] }

export interface ScenarioSummary { id: string; title: string; category: string; type: "troubleshoot" | "build"; difficulty: string; estimated_minutes: number; tags?: string[]; requires_addons?: string[]; summary: string; namespace: string; check_count: number; hint_count: number; related_lessons?: string[]; state?: string; passed_at?: number | null }
export interface ScenarioState { status: string; hints_revealed: number; attempts: number; loaded_at?: number | null; passed_at?: number | null; solution_viewed?: boolean; error?: string | null }
export interface Scenario extends Omit<ScenarioSummary, "state"> { brief: string; concepts?: string[]; checks: { name: string }[]; revealed_hints: string[]; state: ScenarioState; lesson_items: { realm: string; slug: string; title: string }[] }
export interface CheckResult { name: string; passed: boolean; output: string; seconds: number }
export interface CheckResponse { passed: boolean; results: CheckResult[]; attempts: number; concepts?: string[] | null }

export interface Job { id: string; kind: string; label: string; status: "running" | "succeeded" | "failed"; returncode: number | null; started_at: number; finished_at: number | null; duration: number; output: string[]; line_count: number; meta: Record<string, string> }
export interface NodeInfo { name: string; ready: boolean; role: string; version: string; unschedulable: boolean; taints: string[] }
export interface ClusterStatus { docker: boolean; kind_installed: boolean; cluster_name: string; exists: boolean; api_reachable: boolean; nodes: NodeInfo[]; addons: Record<string, boolean>; kubeconfig: string; running_jobs: Job[] }
export interface ProgressItem { kind: string; item_id: string; status: string; data: Record<string, unknown>; updated_at: number }
export interface Progress { items: ProgressItem[]; totals: Record<string, number>; done: Record<string, number>; courses?: Record<string, CourseProgress> }

// ---------------------------------------------------------------------------
// Platform (contract section 3)
// ---------------------------------------------------------------------------
export type AuthMode = "local" | "accounts";
export type LabMode = "local" | "hosted";
export interface Meta { product: string; version: string; auth_mode: AuthMode; lab_mode: LabMode; billing_enabled: boolean; signup_enabled: boolean }

export interface User { id: string; email: string; name: string; role: "user" | "admin"; tier: "free" | "pro"; created_at: number }
export interface Entitlements { pro: boolean; products: string[]; admin: boolean }
export interface AuthResponse { user: User; entitlements: Entitlements; token?: string }

export interface ExamDomain { id: string; title: string; weight?: number }
export type ProductKind = "course" | "bundle";
export type Via = "purchase" | "bundle" | "pro" | "admin" | null;
export interface ProductSummary {
  id: string; title: string; kind: ProductKind; status: "active" | "draft"; order: number; featured: boolean;
  price_cents: number; currency: string; tagline: string; description: string; features: string[];
  difficulty: string; duration_hours: number; includes: string[]; exam_domains?: ExamDomain[]; disclaimer?: string;
  lesson_count: number; assessment_count: number; exercise_count: number;
  owned: boolean; via: Via; progress_percent: number;
}
export interface CourseLessonSummary { slug: string; title: string; order: number; module: number; module_title: string; estimated_minutes: number; preview: boolean; locked: boolean; completed: boolean; summary: string }
export interface AssessmentSummary { id: string; title: string; kind: "pre" | "final" | "domain" | "practice"; question_count: number; time_limit_minutes: number; pass_percent: number; locked: boolean; best_percent: number | null; attempts: number }
export interface ExerciseSummary { id: string; title: string; order: number; domain: string | null; difficulty: string; mode: "legacy" | "scenario"; scenario: string | null; locked: boolean; status: "idle" | "done" }
export interface ProductDetail extends ProductSummary { lessons: CourseLessonSummary[]; assessments: AssessmentSummary[]; exercises: ExerciseSummary[]; included_products?: ProductSummary[] }
export interface ProPlan { price_cents: number; currency: string; interval: string; enabled: boolean }
export interface ProductsResponse { products: ProductSummary[]; pro: ProPlan }

export interface CourseLesson {
  title: string; slug: string; product: string; order: number; module: number; module_title: string; summary: string;
  estimated_minutes: number; level: string; tags?: string[]; preview: boolean; objectives?: string[]; prerequisites?: string[];
  domain?: string | null; quiz?: QuizQ[]; scenarios?: string[]; builders?: string[];
  body: string; prev: { slug: string; title: string } | null; next: { slug: string; title: string } | null; completed: boolean;
  scenario_items: ScenarioSummary[]; builder_items: BuilderSummary[];
}
export interface AssessmentQuestion { q: string; options: string[]; domain?: string; difficulty?: string }
export interface Assessment { id: string; title: string; product: string; kind: "pre" | "final" | "domain" | "practice"; description: string; time_limit_minutes: number; pass_percent: number; domain: string | null; order: number; questions: AssessmentQuestion[]; attempts: number; best_percent: number | null }
export interface AssessmentQuestionResult { index: number; correct: boolean; answer: number; chosen: number | null; explain: string }
export interface AssessmentResult { score: number; total: number; percent: number; passed: boolean; results: AssessmentQuestionResult[]; by_domain: Record<string, { correct: number; total: number }> }
export interface Exercise {
  id: string; title: string; product: string; order: number; domain: string | null; difficulty: string; objective: string; task: string;
  hints: string[]; solution_commands: string[]; setup_commands?: string[]; time_limit_minutes: number; points: number; mode: "legacy" | "scenario";
  scenario: string | null; suggested_scenario?: string | null; locked: boolean; scenario_item: ScenarioSummary | null;
}

export interface LabToken { id: string; name: string; created_at: number; last_used_at: number | null }
export interface LabTokenCreated { id: string; name: string; token: string }
export interface SyncStatus { configured: boolean; platform_url: string; last_sync: number | null; last_error: string | null }
export interface Purchase { product: string; amount_cents: number; currency: string; granted_at: number; expires_at: number | null }
export interface Purchases { purchases: Purchase[]; subscription: { status: string; current_period_end: number | null } | null }
export interface CourseProgress { completed: number; total: number; percent: number }
