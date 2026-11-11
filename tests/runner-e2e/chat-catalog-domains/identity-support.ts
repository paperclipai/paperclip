import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { observeInternal, type Entity, type InternalObservation } from "./internal-support.js";

export interface IdentityObservation extends InternalObservation {
  companies: Entity[]; company: Entity; agents: Entity[]; interactions: Interaction[];
}
export interface Interaction extends Entity {
  idempotencyKey?: string | null;
  kind: string; status: string; payload: { prompt?: string; runtimeRequestId?: string; toolAction?: { connectionId?: string; actionRequestId?: string }; questionSet?: { description?: string; submitLabel?: string; questions: Array<{ id: string; prompt: string; answerMode: string; required?: boolean; customAnswer?: { enabled: boolean; label?: string } }> } };
  result?: { outcome?: string; commentId?: string; toolAction?: { status: string; errorCode?: string | null; errorMessage?: string | null }; answers?: Array<{ questionId: string; otherText?: string; optionIds?: string[] }> };
  resolvedByUserId?: string; resolvedByAgentId?: string; sourceRunId?: string;
}
export async function openStandingChat(ctx: ChatCatalogContext) {
  await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
  await ctx.refreshIssue();
  if (!ctx.issue()) throw new Error("Public standing-chat creation did not persist");
  return ctx.issue()!;
}
export async function observeIdentity(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<IdentityObservation> {
  const internal = await observeInternal(ctx, state);
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const [companies, company, agents, interactions] = await Promise.all([
    ctx.input.api.get<Entity[]>("/api/companies"), ctx.input.api.get<Entity>(root),
    ctx.input.api.get<Entity[]>(`${root}/agents`),
    ctx.issue() ? ctx.input.api.get<Interaction[]>(`/api/issues/${ctx.issue()!.id}/interactions`) : Promise.resolve([]),
  ]);
  return { ...internal, companies, company, agents, interactions };
}
export function identityObservation(value: unknown): IdentityObservation | undefined {
  const o = value as IdentityObservation | undefined;
  return o && typeof o.companyId === "string" && typeof o.leadId === "string" && !!o.state && !!o.company
    && [o.tasks, o.projects, o.goals, o.activity, o.documents, o.links, o.runs, o.companies, o.agents, o.interactions].every(Array.isArray) ? o : undefined;
}
export function identityDefinition(scenarioId: string, setup: ChatCatalogCase["setup"], grade: ChatCatalogCase["grade"], extra: Partial<ChatCatalogCase> = {}): ChatCatalogCase {
  const definition: ChatCatalogCase = { scenarioId, setup, grade, observe: observeIdentity, oracleVersion: "paperclip.chat-catalog.identity.v1",
    sourceFiles: ["chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", `chat-catalog-domains/identity-${scenarioId.split(".")[0]}.ts`, `chat-scenarios/${scenarioId.split(".")[0]}.yaml`],
    expectedRunCount: 1, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
    async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); }, ...extra };
  return { ...definition,
    async setup(ctx) {
      try { return await definition.setup(ctx); }
      catch (error) { await cleanupIdentityProbes(ctx); throw error; }
    },
    async cleanup(ctx, state) {
      try { await cleanupIdentityProbes(ctx); }
      finally { await definition.cleanup?.(ctx, state); }
    },
  };
}
/** Opt-in callers consume the original flow clock, never a fresh outer budget. */
export function remainingIdentityObservationBudget(ctx: ChatCatalogContext): number {
  const deadline = ctx.observationDeadlineAt;
  const now = Date.now();
  if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original identity observation budget exhausted or missing");
  return deadline! - now;
}
export async function waitForReply(ctx: ChatCatalogContext, observationDeadlineAt?: number) {
  const { pollUntil } = await import("../api.js");
  await pollUntil({ label: "initial identity response", deadlineAt: observationDeadlineAt ?? Date.now() + 150_000, intervalMs: 500,
    load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: ({ issue, runs }) => (observationDeadlineAt === undefined || Date.now() < observationDeadlineAt) && issue?.conversationState === "waiting" && runs.length === 1 && runs.every(run => run.status === "succeeded"),
    reject: ({ runs }) => runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Initial response failed" : undefined });
}
export async function identityWorker(ctx: ChatCatalogContext, name = "Morgan") {
  const { api, execution, fixtures, workspacePath, nonce } = ctx.input;
  const base = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: execution.environment.id,
    workspacePath, secretRefs: fixtures.secretRefs, executionId: nonce });
  const payload = { ...base, name, role: "engineer", title: "Website engineer", reportsTo: fixtures.agent.id,
    runtimeConfig: { ...(base.runtimeConfig as Record<string, unknown>), heartbeat: { enabled: false, maxConcurrentRuns: 1 } } };
  const { codexSubscriptionAgentConfig } = await import("../codex-subscription-fixture.js");
  return api.post<Entity>(`/api/companies/${fixtures.company.id}/agents`, execution.profile.credential === "CODEX_AUTH_JSON"
    ? codexSubscriptionAgentConfig(payload, process.env, fixtures.company.id) : payload);
}
/** Real agent bearer, public route and HTTP status. Never pass bearer into
 * Playwright requests, case state, screenshots, model context or evidence. */
const identityProbeKeys = new WeakMap<ChatCatalogContext, Promise<{ id: string; token: string }>>();
async function identityProbeKey(ctx: ChatCatalogContext) {
  if (!ctx.input.privateSecrets) throw new Error("Identity probes require attempt-private credential redaction");
  let pending = identityProbeKeys.get(ctx);
  if (!pending) {
    pending = ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `access-check-${ctx.input.nonce}` })
      .then(key => { ctx.input.privateSecrets!.push(key.token); return key; });
    identityProbeKeys.set(ctx, pending);
  }
  return pending;
}
export async function cleanupIdentityProbes(ctx: ChatCatalogContext) {
  const pending = identityProbeKeys.get(ctx); if (!pending) return;
  const key = await pending;
  await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`, { allowNotFound: true });
  identityProbeKeys.delete(ctx);
}
export async function probeAgentPermission(ctx: ChatCatalogContext, path: string, method: string, body?: unknown) {
    return (await probeAgentPermissionResponse(ctx, path, method, body)).status;
}
/** Same probe, also returning the server's error text so a fixture can tell which gate denied it. */
export async function probeAgentPermissionResponse(ctx: ChatCatalogContext, path: string, method: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; error?: string }> {
    const target = new URL(path, ctx.input.api.baseURL);
    if (target.origin !== ctx.input.api.baseURL || !target.pathname.startsWith("/api/")) throw new Error("Agent permission probe escaped fixture API");
    const key = await identityProbeKey(ctx);
    const response = await fetch(target, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { ...extraHeaders, Authorization: `Bearer ${key.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.ok) { await response.body?.cancel(); return { status: response.status }; }
    const error = await response.json().then(value => (value as { error?: unknown }).error, () => undefined);
    return { status: response.status, ...(typeof error === "string" ? { error } : {}) };
}
export async function readAgentResource(ctx: ChatCatalogContext, path: string): Promise<{ status: number; data?: unknown }> {
    const target = new URL(path, ctx.input.api.baseURL);
    if (target.origin !== ctx.input.api.baseURL || !target.pathname.startsWith("/api/")) throw new Error("Agent read escaped fixture API");
    const key = await identityProbeKey(ctx);
    const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key.token}` } });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    return { status: response.status, data: await response.json() };
}
export async function followRenderedLink(ctx: ChatCatalogContext, href: string) {
  const link = ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first();
  await expect(link).toBeVisible(); await link.click();
}
