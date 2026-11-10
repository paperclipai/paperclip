/**
 * The board's side of the journey workloads (journeys.ts). Each poll the observer
 * hands the driver its sample; the driver acts through the routes the board UI
 * uses, only while the server is ready and no fault is in progress, and records
 * what it did and saw on `record.journey`.
 */
import { readFileSync } from "node:fs";
import { connectionGrants, toolActionRequests, toolConnections } from "../../packages/db/src/schema/index.js";
import { ChaosApiError, type ChaosApi } from "./api.js";
import { ACTIVE_RUN_STATUSES } from "./grader.js";
import { startOAuthApp, TOOL_NAME, type OAuthApp } from "./journey-oauth-app.js";
import {
  ANSWER_TURN_WAIT_MS, answerMarker, isJourneyWorkload, journeyChoice, Q3_REVIEW_AGE_MS, q3ToolArgument,
  type JourneyArtifacts, type JourneyRecord, type JourneyWorkload,
} from "./journeys.js";
import type { ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type { ScheduledFault, TaskPlan, TaskRecord, TaskSample } from "./types.js";

type Json = Record<string, any>;

export interface JourneyHost {
  plan: TaskPlan;
  api: ChaosApi;
  lab: ChaosLab;
  timeline: Timeline;
  record: TaskRecord;
  /** The wave database (Q3 moves the review's saved timestamps). */
  databaseUrl: () => string | null;
}

/** What the observer knows each poll that the board's decision depends on. */
export interface JourneyTick {
  sample: TaskSample;
  now: number;
  /** Server ready and no fault in progress. */
  quiet: boolean;
  /** The task's faults that have not fired yet. */
  pendingFaults: readonly ScheduledFault[];
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const httpStatus = (error: unknown) => error instanceof ChaosApiError ? error.status : null;
const hasActiveRun = (sample: TaskSample) => (sample.runs ?? []).some(run => ACTIVE_RUN_STATUSES.has(run.status));

/** Apps → Review rows: `{ actionRequests: [{ request: {...}, ... }] }`; each row's request carries id, issueId and status. */
export function actionRequestRows(body: unknown): Json[] {
  const rows = Array.isArray(body) ? body : (body as { actionRequests?: unknown } | null)?.actionRequests;
  return (Array.isArray(rows) ? rows as Json[] : []).map(row => (row?.request && typeof row.request === "object" ? row.request : row) as Json);
}

/**
 * The board's answer as the question form sends it: the option whose id or label is the chosen
 * code word. The agent wrote the card with its own ids, so the board reads them, as a person would.
 */
export function questionAnswer(interaction: Json, choice: string): { questionId: string; optionIds: string[] } | null {
  const payload = (interaction.payload ?? {}) as Json;
  const questions = [...(payload.questionSet?.questions ?? []), ...(payload.questions ?? [])] as Json[];
  for (const question of questions) {
    const option = ((question.options ?? []) as Json[]).find(candidate => [candidate.id, candidate.label]
      .some(value => typeof value === "string" && value.trim().toLowerCase() === choice));
    if (option && typeof question.id === "string") return { questionId: question.id, optionIds: [String(option.id)] };
  }
  return null;
}

/** The scripted Q3 agent: one connected-app call, then report the reviewed result. Adapted from tests/e2e/connection-reviews.spec.ts. */
export function q3AgentScript(connectionId: string, title: string, serverBaseUrl: string): string {
  // The wave's own loopback server. On a tailnet host, PAPERCLIP_API_URL names the machine's
  // public URL, which reaches a different instance.
  return `
const base = ${JSON.stringify(serverBaseUrl)} + "/api";
const headers = { authorization: "Bearer " + process.env.PAPERCLIP_API_KEY, "content-type": "application/json", "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID };
const api = async (path, method = "GET", body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(method + " " + path + " " + response.status + ": " + await response.text());
  return await response.json();
};
let issueId = process.env.PAPERCLIP_TASK_ID;
try {
// This agent is hired for one task: find it by its own assignment.
const assigned = await api("/companies/" + process.env.PAPERCLIP_COMPANY_ID + "/issues?assigneeAgentId=" + process.env.PAPERCLIP_AGENT_ID);
issueId ??= (Array.isArray(assigned) ? assigned : assigned.issues ?? []).find(item => item.title?.includes(${JSON.stringify(title)}))?.id;
if (!issueId) throw new Error("No assigned task names " + ${JSON.stringify(title)});
const review = (await api("/issues/" + issueId + "/interactions")).find(item => item.payload?.toolAction);
if (review?.status === "pending") { console.log("Waiting for the saved review; no retry."); process.exit(0); }
if (review) {
  const result = review.result?.toolAction;
  if (review.status === "accepted" && (!result || ["approved", "executing"].includes(result.status))) { console.log("Approved; waiting for the stored result."); process.exit(0); }
  const executed = review.status === "accepted" && result?.status === "executed";
  await api("/issues/" + issueId + "/comments", "POST", { body: (executed ? "Q3 result: " : "Q3 review ended " + review.status + ": ") + JSON.stringify(result ?? null) });
  if (executed) await api("/issues/" + issueId, "PATCH", { status: "done" });
  process.exit(0);
}
const session = await api("/tool-gateway/sessions", "POST", { runId: process.env.PAPERCLIP_RUN_ID, ttlMs: 60000 });
const gatewayHeaders = { "x-paperclip-tool-gateway-token": session.token, "content-type": "application/json" };
const tools = await (await fetch(base + "/tool-gateway/tools", { headers: gatewayHeaders })).json();
const tool = tools.find(t => t.connectionId === ${JSON.stringify(connectionId)});
if (!tool) throw new Error("The chaos app tool is not available to this agent");
const call = await fetch(base + "/tool-gateway/tools/call", { method: "POST", headers: gatewayHeaders, body: JSON.stringify({ tool: tool.name, parameters: { title: ${JSON.stringify(title)} } }) });
const outcome = await call.json();
if (!call.ok) {
  if (!JSON.stringify(outcome).includes("approval_required")) throw new Error(JSON.stringify(outcome));
  await api("/issues/" + issueId, "PATCH", { status: "in_review" });
  console.log("Waiting for the board's review. No retry.");
  process.exit(0);
}
await api("/issues/" + issueId + "/comments", "POST", { body: "Q3 ran without review: " + JSON.stringify(outcome) });
} catch (error) {
  // Leave the failure on the task, where the evidence bundle collects it.
  console.error(error);
  if (issueId) await api("/issues/" + issueId + "/comments", "POST", { body: "Q3 agent error: " + String(error?.stack ?? error).slice(0, 2000) }).catch(() => {});
  process.exit(1);
}
`;
}

/** Drivers with a running Q3 app; the wave closes any still open at teardown. */
const openDrivers = new Set<JourneyDriver>();
export async function closeJourneyApps(): Promise<void> {
  await Promise.all([...openDrivers].map(driver => driver.close()));
}

export class JourneyDriver {
  private app: OAuthApp | null = null;
  /** Q2: ready time accumulated since the answer, for the answer-turn wait. */
  private quietSinceAnswerMs = 0;
  private lastTickAt: number | null = null;

  constructor(readonly workload: JourneyWorkload, private readonly host: JourneyHost) {
    const own = host.plan.trigger && host.plan.trigger !== "time" ? host.plan.trigger : null;
    this.state.faultTrigger = own;
  }

  get state(): JourneyRecord { return this.host.record.journey ??= {}; }

  /** Q3: the scripted agent that calls the connected app; others use the seeded agent. */
  get assigneeAgentId(): string | null { return this.state.app?.agentId ?? null; }

  /** Q3: start the harness's OAuth app, connect it as the board, and hire the scripted agent. */
  async prepare(): Promise<void> {
    if (this.workload !== "Q3" || this.state.app) return;
    const { api, lab, plan, timeline } = this.host;
    const app = this.app = await startOAuthApp();
    openDrivers.add(this);
    const state: NonNullable<JourneyRecord["app"]> = this.state.app = { connectionId: null, agentId: null, receipt: app.receipt, setupError: null };
    try {
      const connected = await api.post<Json>(`/api/companies/${lab.companyId}/tools/apps/connect`,
        { link: app.mcpUrl, name: `Chaos pages ${plan.nonce}`, grantKind: "organization" }, 30_000);
      state.connectionId = String(connected.connectionId ?? connected.connection?.id);
      const startUrl = connected.auth?.startUrl;
      if (typeof startUrl !== "string") throw new Error(`connect returned no OAuth start URL: ${JSON.stringify(connected).slice(0, 300)}`);
      // The browser visits the app, consents, and is sent back to Paperclip's callback.
      const authorize = await fetch(startUrl, { redirect: "manual" });
      const location = authorize.headers.get("location");
      if (!location) throw new Error(`authorize returned ${authorize.status} without a redirect`);
      const back = new URL(location);
      const callback = await fetch(`${api.baseUrl}${back.pathname}${back.search}`,
        { headers: { origin: api.baseUrl, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (callback.status >= 400) throw new Error(`OAuth callback returned ${callback.status}: ${(await callback.text()).slice(0, 300)}`);
      const { catalog } = await api.get<{ catalog: Json[] }>(`/api/tool-connections/${state.connectionId}/catalog`);
      const entry = (catalog ?? []).find(row => row.toolName === TOOL_NAME || String(row.upstreamToolName ?? "").endsWith(TOOL_NAME));
      if (!entry) throw new Error(`catalog has no ${TOOL_NAME}: ${JSON.stringify(catalog).slice(0, 300)}`);
      const agent = await api.post<Json>(`/api/companies/${lab.companyId}/agents`, {
        name: `Chaos pages agent ${plan.nonce}`, role: "engineer", title: "Connected-app journey agent",
        capabilities: "Creates one page with the chaos app after review.", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["--input-type=module", "-e", q3AgentScript(state.connectionId, q3ToolArgument(plan.nonce), api.baseUrl)] },
      });
      state.agentId = String(agent.id);
      // A scripted process run records usage with no price, which the company's default budget
      // policy blocks (pausing the whole company). The operator allows unpriced usage, as the
      // budget page offers; the amount and hard stop stay in force for priced model usage.
      await api.post(`/api/companies/${lab.companyId}/budgets/policies`,
        { scopeType: "company", scopeId: lab.companyId, unpricedUsagePolicy: "allow" });
      // Apps → finish: this agent may use the app, and the write tool asks first.
      await api.post(`/api/companies/${lab.companyId}/tools/apps/${state.connectionId}/finish`, {
        enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: [entry.id], access: { agentIds: [state.agentId] } });
      timeline.add("journey_app_connected", { taskId: plan.taskId, connectionId: state.connectionId, agentId: state.agentId, origin: app.origin });
    } catch (error) {
      state.setupError = errorText(error);
      timeline.add("journey_app_setup_failed", { taskId: plan.taskId, error: state.setupError });
      // No issue exists yet, so artifact collection (which closes the app) never runs for this task.
      await this.close();
      throw new Error(`Q3 app setup failed: ${state.setupError}`);
    }
  }

  armedAt(trigger: "asked" | "answered"): number | null {
    return trigger === "asked" ? this.state.requestSeenAt ?? null : this.state.answer?.doneAt ?? null;
  }

  /** The task waits on the board: not a rest, not a stall, no Retry. */
  awaitingBoard(): boolean {
    const state = this.state;
    if (!state.requestSeenAt) return false;
    if (this.workload === "Q2") return !state.blockerResolved && (!state.answer || state.answer.error === null);
    return !state.answer;
  }

  /** One poll. Returns true when the board acted (the observer then needs fresh samples before rest). */
  async step(tick: JourneyTick): Promise<boolean> {
    const { sample, now, quiet } = tick;
    const previous = this.lastTickAt;
    this.lastTickAt = now;
    if (quiet && previous !== null && this.state.answer) this.quietSinceAnswerMs += now - previous;
    if (!sample.reachable || !this.host.record.issueId) return false;
    if (this.workload === "Q3" && this.state.app?.setupError) return false;
    if (!this.state.requestSeenAt && !(await this.findRequest(now))) return false;
    // The board answers once every fault the task planned before the answer has fired.
    const answerMayGo = quiet && tick.pendingFaults.every(fault => fault.trigger === "answered");
    if (this.workload === "Q2" && !this.state.blocker) {
      if (!quiet || hasActiveRun(sample)) return false;
      await this.addPrerequisite(now);
      return true;
    }
    if (!this.state.answer) {
      if (!answerMayGo) return false;
      if (this.workload === "Q2" && this.state.blocker?.error) return false;
      if (this.workload === "Q3") await this.ageAndRefresh(now);
      await this.respond(now);
      return true;
    }
    if (this.workload !== "Q2" || this.state.answer.error !== null) return false;
    if (!this.state.answerTurn) {
      if (!quiet) return false;
      if (await this.observeAnswerTurn(now, sample)) return false;
      if (this.quietSinceAnswerMs < ANSWER_TURN_WAIT_MS) return false;
      this.state.answerTurn = { missedAt: now };
      this.host.timeline.add("journey_answer_turn_missed", { taskId: this.host.plan.taskId, waitedMs: this.quietSinceAnswerMs });
    }
    if (!this.state.blockerResolved && quiet && tick.pendingFaults.length === 0 && !hasActiveRun(sample)) {
      await this.finishPrerequisite(now);
      return true;
    }
    return false;
  }

  private async findRequest(now: number): Promise<boolean> {
    const { api, lab, record, timeline, plan } = this.host;
    let id: string | null = null;
    if (this.workload === "Q3") {
      const rows = await api.get<unknown>(`/api/companies/${lab.companyId}/tools/action-requests?status=pending`, 5_000).catch(() => null);
      id = actionRequestRows(rows).find(row => row.issueId === record.issueId)?.id ?? null;
    } else {
      const rows = await api.get<Json[]>(`/api/issues/${record.issueId}/interactions`, 5_000).catch(() => null);
      id = (rows ?? []).find(row => row.kind === "ask_user_questions" && row.status === "pending")?.id ?? null;
    }
    if (!id) return false;
    this.state.requestSeenAt = now;
    this.state.requestId = String(id);
    timeline.add("journey_request_pending", { taskId: plan.taskId, workload: this.workload, requestId: id });
    return true;
  }

  /** Q2: the board adds an unfinished, unassigned prerequisite and marks the task blocked by it. */
  private async addPrerequisite(now: number) {
    const { api, lab, record, plan, timeline } = this.host;
    const blocker: NonNullable<JourneyRecord["blocker"]> = { issueId: null, at: now, error: null };
    try {
      const created = await api.post<Json>(`/api/companies/${lab.companyId}/issues`,
        { title: `Chaos Q2 prerequisite ${plan.nonce}`, status: "backlog", priority: "medium" });
      blocker.issueId = String(created.id);
      await api.patch(`/api/issues/${record.issueId}`, { status: "blocked", blockedByIssueIds: [blocker.issueId] });
    } catch (error) {
      blocker.error = errorText(error);
    }
    this.state.blocker = blocker;
    timeline.add("journey_prerequisite_added", { taskId: plan.taskId, ...blocker });
  }

  /** Q3: the review waits more than an hour. Move its saved timestamps and the access token's expiry back. */
  private async ageAndRefresh(now: number) {
    const { api, plan, timeline } = this.host;
    if (!this.state.timeShift) {
      const shift: NonNullable<JourneyRecord["timeShift"]> = { at: now, ms: Q3_REVIEW_AGE_MS, requests: 0, grants: 0, error: null };
      try { Object.assign(shift, await shiftReviewClock(this.host.databaseUrl(), this.state.requestId!, this.state.app!.connectionId!, Q3_REVIEW_AGE_MS)); }
      catch (error) { shift.error = errorText(error); }
      this.state.timeShift = shift;
      timeline.add("journey_review_aged", { taskId: plan.taskId, ...shift });
    }
    if (!this.state.refresh) {
      // Apps → connection → Check connection: a routine use that renews the expiring token.
      const refresh: NonNullable<JourneyRecord["refresh"]> = { at: Date.now(), httpStatus: null, error: null };
      try { await api.post(`/api/tool-connections/${this.state.app!.connectionId}/health-check`, {}, 30_000); refresh.httpStatus = 200; }
      catch (error) { refresh.httpStatus = httpStatus(error); refresh.error = errorText(error); }
      this.state.refresh = refresh;
      timeline.add("journey_connection_checked", { taskId: plan.taskId, ...refresh, refreshes: this.app?.record.refreshes.length ?? null });
    }
  }

  private async respond(now: number) {
    const { api, lab, record, plan, timeline } = this.host;
    const answer: NonNullable<JourneyRecord["answer"]> = { at: now, doneAt: now, httpStatus: null, error: null, status: null,
      pendingWhenAnswered: false, faultsBefore: record.faultIds.length };
    try {
      const request = await this.currentRequest();
      const status = request?.status ?? null;
      answer.pendingWhenAnswered = status === "pending";
      if (status !== "pending") throw new Error(`the saved request is no longer pending (status ${status ?? "missing"})`);
      const choice = this.workload === "Q3" ? null : questionAnswer(request!, journeyChoice(plan.nonce));
      if (this.workload !== "Q3" && !choice) throw new Error(`the saved question offers no option "${journeyChoice(plan.nonce)}"`);
      answer.at = Date.now();
      const response = this.workload === "Q3"
        ? await api.post<Json>(`/api/tool-gateway/action-requests/${this.state.requestId}/approve`, { companyId: lab.companyId }, 60_000)
        : await api.post<Json>(`/api/issues/${record.issueId}/interactions/${this.state.requestId}/respond`, { answers: [choice] }, 30_000);
      answer.httpStatus = 200;
      answer.status = typeof response?.status === "string" ? response.status : null;
    } catch (error) {
      answer.httpStatus = httpStatus(error);
      answer.error = errorText(error);
    }
    answer.doneAt = Math.max(Date.now(), now);
    this.state.answer = answer;
    timeline.add("journey_board_responded", { taskId: plan.taskId, workload: this.workload, requestId: this.state.requestId, ...answer });
  }

  /** The saved request as the board sees it now (Q3: listed only while pending). */
  private async currentRequest(): Promise<Json | null> {
    const { api, lab, record } = this.host;
    if (this.workload === "Q3") {
      const rows = await api.get<unknown>(`/api/companies/${lab.companyId}/tools/action-requests?status=pending`, 10_000);
      return actionRequestRows(rows).some(row => row.id === this.state.requestId) ? { status: "pending" } : { status: "not pending" };
    }
    const rows = await api.get<Json[]>(`/api/issues/${record.issueId}/interactions`, 10_000);
    return rows.find(row => row.id === this.state.requestId) ?? null;
  }

  /** Q2: the agent's reply to the answer, while the prerequisite is still unfinished. */
  private async observeAnswerTurn(now: number, sample: TaskSample): Promise<boolean> {
    const { api, record, plan, timeline } = this.host;
    if (hasActiveRun(sample)) return false;
    const comments = await api.get<Json[]>(`/api/issues/${record.issueId}/comments`, 5_000).catch(() => null);
    const since = this.state.answer!.at;
    const marker = answerMarker(plan.nonce);
    const reply = (comments ?? []).find(comment => comment.authorAgentId && String(comment.body ?? "").includes(marker)
      && Date.parse(comment.createdAt) >= since - 1_000);
    // A bounded answer turn may report the answer in its accepted run result instead of a comment.
    let at = reply ? Date.parse(reply.createdAt) : null;
    if (at === null) {
      for (const run of (sample.runs ?? []).filter(run => run.createdAt && Date.parse(run.createdAt) >= since - 1_000 && run.finishedAt)) {
        const events = await api.get<Json[]>(`/api/heartbeat-runs/${run.id}/events?limit=500`, 5_000).catch(() => null);
        // Only an accepted result counts; a rejected one still carries the proposed body.
        if ((events ?? []).some(event => event.eventType === "run.result.accepted" && JSON.stringify(event.payload ?? {}).includes(marker))) {
          at = Date.parse(run.finishedAt!);
          break;
        }
      }
    }
    if (at === null) return false;
    const issue = await api.get<Json>(`/api/issues/${record.issueId}`, 5_000).catch(() => null);
    const blockerId = this.state.blocker?.issueId;
    const blockedBy = Array.isArray(issue?.blockedBy) ? issue.blockedBy as Json[] : [];
    this.state.answerTurn = { at, issueStatus: issue?.status ?? null,
      blockerKept: Boolean(blockerId) && (blockedBy.some(row => row.id === blockerId) || (issue?.blockedByIssueIds ?? []).includes(blockerId)) };
    timeline.add("journey_answer_turn", { taskId: plan.taskId, observedAt: now, ...this.state.answerTurn });
    return true;
  }

  private async finishPrerequisite(now: number) {
    const { api, plan, timeline } = this.host;
    const resolved: NonNullable<JourneyRecord["blockerResolved"]> = { at: now, error: null };
    try { await api.patch(`/api/issues/${this.state.blocker!.issueId}`, { status: "done" }); }
    catch (error) { resolved.error = errorText(error); }
    this.state.blockerResolved = resolved;
    timeline.add("journey_prerequisite_finished", { taskId: plan.taskId, ...resolved });
  }

  async collect(issueId: string): Promise<JourneyArtifacts> {
    const { api, lab } = this.host;
    const [issue, interactions, comments, runs] = await Promise.all([
      api.get<Json>(`/api/issues/${issueId}`).catch(() => null),
      api.get<Json[]>(`/api/issues/${issueId}/interactions`).catch(() => []),
      api.get<Json[]>(`/api/issues/${issueId}/comments`).catch(() => []),
      api.get<Json[]>(`/api/issues/${issueId}/runs`).catch(() => []),
    ]);
    const interruption = issue?.interruption ? { state: issue.interruption.state ?? null, canRetry: issue.interruption.canRetry === true } : null;
    const artifacts: JourneyArtifacts = {
      record: this.state,
      questions: (interactions ?? []).filter(row => row.kind === "ask_user_questions")
        .map(row => ({ id: String(row.id), status: String(row.status), createdAt: row.createdAt ?? null })),
      agentComments: (comments ?? []).filter(comment => comment.authorAgentId)
        .map(comment => ({ createdAt: Date.parse(comment.createdAt), body: String(comment.body ?? "") })).sort((a, b) => a.createdAt - b.createdAt),
      runErrorCodes: (runs ?? []).map(run => run.errorCode).filter((code): code is string => typeof code === "string"),
      interruption,
    };
    if (this.workload === "Q3") {
      const rows = await Promise.all(["pending", "approved", "executing", "rejected", "expired", "cancelled", "executed", "failed"]
        .map(status => api.get<unknown>(`/api/companies/${lab.companyId}/tools/action-requests?status=${status}`).catch(() => [])));
      const requests = new Map<string, string>();
      for (const page of rows) for (const row of actionRequestRows(page)) {
        if (row.issueId === issueId) requests.set(String(row.id), String(row.status));
      }
      artifacts.actionRequests = [...requests].map(([id, status]) => ({ id, status }));
      // The scripted agent's own output for every run that did not succeed.
      for (const run of (runs ?? []).filter(row => row.status !== "succeeded").slice(-5)) {
        const id = String(run.runId ?? run.id);
        const log = await api.get<Json>(`/api/heartbeat-runs/${id}/log?limitBytes=8000`).catch(error => ({ error: errorText(error) }));
        (artifacts.runLogs ??= {})[id] = JSON.stringify(log).slice(-4000);
      }
      artifacts.provider = this.app ? { toolCalls: [...this.app.record.toolCalls], refreshes: [...this.app.record.refreshes] } : { toolCalls: [], refreshes: [] };
    }
    return artifacts;
  }

  async close(): Promise<void> { openDrivers.delete(this); await this.app?.close().catch(() => undefined); this.app = null; }
}

/**
 * Q3: the honest way to let more than an hour pass for one review in an isolated wave database.
 * The pending request's created/updated/deadline timestamps and the OAuth grant's access-token
 * expiry (and last refresh) move back by `ms`, as GRACE_SHIFT_MS does for the invariant pass.
 * Nothing else changes; the product's own code decides what that elapsed time means.
 */
export async function shiftReviewClock(databaseUrl: string | null, actionRequestId: string, connectionId: string, ms: number) {
  if (!databaseUrl) throw new Error("the wave database URL is unknown");
  const { createDb } = await import("../../packages/db/src/index.js");
  const db = createDb(databaseUrl);
  const client = (db as unknown as { $client: SqlClient & { end(options?: { timeout?: number }): Promise<void> } }).$client;
  try {
    return await shiftReviewClockWith(client, reviewClockNames(), actionRequestId, connectionId, ms);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export interface SqlClient { unsafe(query: string, params?: unknown[]): Promise<Json[]> }

type SchemaTable = Record<string, unknown>;
const tableName = (table: SchemaTable) => String(table[Symbol.for("drizzle:Name") as unknown as string]);
const columnName = (table: SchemaTable, key: string) => {
  const column = table[key] as { name?: unknown } | undefined;
  if (typeof column?.name !== "string") throw new Error(`schema table ${tableName(table)} has no column ${key}`);
  return column.name;
};

/** Table and column names from the Drizzle schema, so a rename fails here, not as a vague live-wave ageing error. */
export function reviewClockNames() {
  const requests = toolActionRequests as unknown as SchemaTable, grants = connectionGrants as unknown as SchemaTable;
  const connections = toolConnections as unknown as SchemaTable;
  return {
    requests: tableName(requests), requestId: columnName(requests, "id"), requestStatus: columnName(requests, "status"),
    requestTimes: ["createdAt", "updatedAt", "expiresAt"].map(key => columnName(requests, key)),
    grants: tableName(grants), grantId: columnName(grants, "id"), grantConnection: columnName(grants, "connectionId"),
    grantTenant: columnName(grants, "providerTenant"),
    connections: tableName(connections), connectionId: columnName(connections, "id"),
    connectionConfig: columnName(connections, "config"), connectionTransport: columnName(connections, "transportConfig"),
  };
}

export async function shiftReviewClockWith(client: SqlClient, names: ReturnType<typeof reviewClockNames>, actionRequestId: string,
  connectionId: string, ms: number) {
  {
    const n = names;
    const interval = `${Math.round(ms / 1000)} seconds`;
    const requests = await client.unsafe(`UPDATE ${n.requests} SET ${n.requestTimes.map(column => `${column} = ${column} - $2::interval`).join(", ")}
      WHERE ${n.requestId} = $1 AND ${n.requestStatus} = 'pending' RETURNING ${n.requestId}`, [actionRequestId, interval]);
    const grants = await client.unsafe(`SELECT ${n.grantId} AS id, ${n.grantTenant} AS provider_tenant FROM ${n.grants} WHERE ${n.grantConnection} = $1`, [connectionId]);
    let shiftedGrants = 0;
    for (const grant of grants) {
      const tenant = (grant.provider_tenant ?? {}) as Json;
      const oauth = { ...(tenant.oauth ?? {}) } as Json;
      let changed = false;
      for (const key of ["accessTokenExpiresAt", "refreshedAt", "expiresAt"]) {
        const at = typeof oauth[key] === "string" ? Date.parse(oauth[key]) : Number.NaN;
        if (Number.isFinite(at)) { oauth[key] = new Date(at - ms).toISOString(); changed = true; }
      }
      if (!changed) continue;
      await client.unsafe(`UPDATE ${n.grants} SET ${n.grantTenant} = $2::jsonb WHERE ${n.grantId} = $1`, [grant.id, JSON.stringify({ ...tenant, oauth })]);
      shiftedGrants += 1;
    }
    // A shared (organization) connection keeps its token expiry on the connection itself.
    const connections = await client.unsafe(`SELECT ${n.connectionId} AS id, ${n.connectionConfig} AS config, ${n.connectionTransport} AS transport_config
      FROM ${n.connections} WHERE ${n.connectionId} = $1`, [connectionId]);
    for (const connection of connections) {
      const shifted: Record<string, Json | null> = {};
      for (const column of ["config", "transport_config"]) {
        const value = connection[column] as Json | null;
        const oauth = value?.oauth as Json | undefined;
        if (!oauth) continue;
        const next = { ...oauth };
        let changed = false;
        for (const key of ["expiresAt", "refreshedAt", "accessTokenExpiresAt"]) {
          const at = typeof next[key] === "string" ? Date.parse(next[key]) : Number.NaN;
          if (Number.isFinite(at)) { next[key] = new Date(at - ms).toISOString(); changed = true; }
        }
        if (changed) shifted[column] = { ...value, oauth: next };
      }
      if (!Object.keys(shifted).length) continue;
      await client.unsafe(`UPDATE ${n.connections} SET ${n.connectionConfig} = COALESCE($2::jsonb, ${n.connectionConfig}),
        ${n.connectionTransport} = COALESCE($3::jsonb, ${n.connectionTransport}) WHERE ${n.connectionId} = $1`,
        [connection.id, shifted.config ? JSON.stringify(shifted.config) : null, shifted.transport_config ? JSON.stringify(shifted.transport_config) : null]);
      shiftedGrants += 1;
    }
    return { requests: requests.length, grants: shiftedGrants };
  }
}

/** The wave database URL from the instance config (as main.ts reads it for the crash-point suite). */
export function databaseUrlFromConfig(configPath: string | undefined): string | null {
  if (!configPath) return null;
  try {
    return (JSON.parse(readFileSync(configPath, "utf8")) as { database?: { connectionString?: string } }).database?.connectionString ?? null;
  } catch { return null; }
}

export function journeyDriverFor(host: JourneyHost): JourneyDriver | null {
  return isJourneyWorkload(host.plan.workload) ? new JourneyDriver(host.plan.workload, host) : null;
}
