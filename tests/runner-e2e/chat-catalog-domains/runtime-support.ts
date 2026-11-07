import { expect, type Page } from "@playwright/test";
import { pollUntil } from "../api.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { codexSubscriptionAgentConfig } from "../codex-subscription-fixture.js";
import { observeInternal, type Entity, type InternalObservation } from "./internal-support.js";

export interface RuntimeAgent extends Entity {
  reportsTo?: string | null; adapterType?: string; adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>; permissions?: Record<string, unknown>;
  defaultEnvironmentId?: string | null; lifecycleState?: string; lifecycleHolds?: string[]; pauseReason?: string | null;
}
export interface InstructionFile {
  path: string; content: string; revision: { id: string; parentRevisionId?: string | null;
    companyId: string; agentId: string; actorAgentId?: string | null; sourceRunId?: string | null; source: string; restoredFromRevisionId?: string | null };
}
export interface RuntimeObservation extends InternalObservation {
  agents: RuntimeAgent[];
  instruction?: InstructionFile;
  instructionHistory?: { revisions: InstructionFile["revision"][] };
  instructionSideFile?: { content: string };
}
export async function runtimeWorker(ctx: ChatCatalogContext, name = "Morgan", extra: Record<string, unknown> = {}) {
  const { api, execution, fixtures, workspacePath, nonce } = ctx.input;
  const base = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: execution.environment.id,
    workspacePath, secretRefs: fixtures.secretRefs, executionId: nonce });
  const payload = { ...base, name, role: "engineer", title: "Frontend engineer", reportsTo: fixtures.agent.id,
    runtimeConfig: { ...(base.runtimeConfig as Record<string, unknown>), heartbeat: { enabled: false, maxConcurrentRuns: 1 } }, ...extra };
  const agent = await api.post<RuntimeAgent>(`/api/companies/${fixtures.company.id}/agents`, execution.profile.credential === "CODEX_AUTH_JSON"
    ? codexSubscriptionAgentConfig(payload, process.env, fixtures.company.id) : payload);
  return pollUntil({ label: `${name} real runtime readiness`, deadlineAt: Date.now() + 45_000,
    load: () => api.get<RuntimeAgent>(`/api/agents/${agent.id}`), accept: row => row.lifecycleState === "ready" });
}
export async function observeRuntime(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<RuntimeObservation> {
  const o = await observeInternal(ctx, state);
  const agents = await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${o.companyId}/agents`);
  const result: RuntimeObservation = { ...o, agents };
  if (state.instructionAgentId) {
    const root = `/api/agents/${state.instructionAgentId}/instructions-bundle`;
    result.instruction = await ctx.input.api.get<InstructionFile>(`${root}/file?path=AGENTS.md`);
    result.instructionHistory = await ctx.input.api.get(`${root}/history?path=AGENTS.md`);
    result.instructionSideFile = await ctx.input.api.get(`${root}/file?path=guidance.md`);
  }
  return result;
}
export function runtimeObservation(value: unknown): RuntimeObservation | undefined {
  const o = value as RuntimeObservation | undefined;
  return o && o.state && typeof o.reply === "string" && typeof o.companyId === "string" && typeof o.leadId === "string"
    && [o.agents, o.tasks, o.links, o.activity, o.runs, o.humanQueries].every(Array.isArray) ? o : undefined;
}
export function agentLink(o: RuntimeObservation, agent: RuntimeAgent): string | undefined {
  return o.links.find(href => {
    try { const url = new URL(href, o.origin); const parts = url.pathname.split("/").map(decodeURIComponent); const index = parts.indexOf("agents");
      return url.origin === new URL(o.origin).origin && !url.pathname.startsWith("/api/") && index >= 0 && [agent.id, agent.urlKey].includes(parts[index + 1]); }
    catch { return false; }
  });
}
/** Canonical outcomes may name a supported control without a Markdown href. */
export async function openRuntimeAgentProfile(ctx: ChatCatalogContext, agent: RuntimeAgent, o?: RuntimeObservation) {
  const href = o && agentLink(o, agent);
  if (href) await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
  else await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  await expect(ctx.input.page.getByRole("heading", { name: agent.name!, exact: true }).first()).toBeVisible();
}
export async function verifyRuntimeResult(ctx: ChatCatalogContext, state: Record<string, unknown>, value: unknown) {
  const o = runtimeObservation(value); if (!o) throw new Error("Missing independent runtime result");
  const target = o.agents.find(row => row.id === (state.worker as RuntimeAgent | undefined)?.id);
  if (!target) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); return; }
  const source = ctx.input.page.url();
  await openRuntimeAgentProfile(ctx, target, o);
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  await expect(ctx.input.page.getByRole("heading", { name: target.name!, exact: true }).first()).toBeVisible();
  await ctx.input.evidence("chat-catalog-runtime-profile-opened.json", { agentId: target.id, companyId: target.companyId, url: ctx.input.page.url() });
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
}
/**
 * A pending interaction renders inline in the thread as `#interaction-<id>`,
 * or docked in the composer takeover, which carries its title but no id.
 */
export function interactionSurface(page: Page, interaction: { id: string; title?: string | null }) {
  const inline = page.locator(`[id=${JSON.stringify(`interaction-${interaction.id}`)}]`);
  return interaction.title
    ? inline.or(page.getByTestId("task-chat-composer-takeover").filter({ hasText: interaction.title }))
    : inline;
}
/** Open a pending request from its timeline chip when it is not already docked, then use its own action. */
export async function clickInteractionAction(page: Page, interaction: { id: string; title?: string | null }, name: string | RegExp) {
  const docked = page.getByTestId("task-chat-composer-takeover").filter({ hasText: interaction.title ?? "" });
  const action = (interaction.title ? docked : interactionSurface(page, interaction)).getByRole("button", typeof name === "string" ? { name, exact: true } : { name });
  await expect(interactionSurface(page, interaction).first()).toBeVisible();
  if (!(await action.first().isVisible())) await page.locator(`[id=${JSON.stringify(`interaction-${interaction.id}`)}]`).click();
  await action.first().click();
}
export function runtimeDefinition(scenarioId: string, setup: ChatCatalogCase["setup"], grade: ChatCatalogCase["grade"], extra: Partial<ChatCatalogCase> = {}): ChatCatalogCase {
  return { scenarioId, setup, grade, observe: observeRuntime, verifyResult: verifyRuntimeResult,
    oracleVersion: "paperclip.chat-catalog.runtime.v2", coverageGaps: [], expectedRunCount: 1,
    turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
    sourceFiles: ["chat-catalog-domains/runtime-support.ts", `chat-catalog-domains/runtime-${scenarioId.split(".")[0]}.ts`, `chat-scenarios/${scenarioId.split(".")[0]}.yaml`], ...extra };
}
export function unchangedAgent(before: RuntimeAgent, after: RuntimeAgent, except: readonly string[] = []) {
  return ["id", "companyId", "name", "role", "adapterType", "adapterConfig", "runtimeConfig", "permissions", "defaultEnvironmentId", "reportsTo"]
    .filter(key => !except.includes(key)).every(key => JSON.stringify(before[key as keyof RuntimeAgent]) === JSON.stringify(after[key as keyof RuntimeAgent]));
}
