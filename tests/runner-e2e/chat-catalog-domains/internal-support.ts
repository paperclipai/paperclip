import { collectConversationLinks, conversationLinkLocator, type RenderedConversationLink } from "../chat-rendered-links.js";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatRun } from "../chat-flow.js";

export interface Entity {
  id: string; companyId?: string; name?: string; title?: string; description?: string | null;
  identifier?: string; urlKey?: string; status?: string; priority?: string; assigneeAgentId?: string | null;
  projectId?: string | null; parentId?: string | null; goalId?: string | null; goalIds?: string[];
  level?: string; ownerAgentId?: string | null; archivedAt?: string | null;
  key?: string; body?: string; latestRevisionId?: string; latestRevisionNumber?: number;
  createdByAgentId?: string | null; updatedByAgentId?: string | null; createdByRunId?: string | null;
  createdAt?: string; updatedAt?: string; authorAgentId?: string | null; authorUserId?: string | null;
  issueId?: string; action?: string; agentId?: string | null; actorId?: string; actorType?: string;
  entityId?: string; documentId?: string; originalRevisionId?: string | null; currentRevisionId?: string | null; resolvedByAgentId?: string | null; selectedText?: string; resolvedAt?: string | null; details?: Record<string, unknown>;
}
export interface InternalObservation {
  scenarioId: string; origin: string; companyId: string; leadId: string; state: Record<string, unknown>;
  tasks: Entity[]; projects: Entity[]; goals: Entity[]; comments: Entity[];
  renderedLinkEvidence?: RenderedConversationLink[]; activity: Entity[]; annotations?: Entity[]; agents?: Entity[]; documents: Entity[]; revisions: Entity[]; reply: string; links: string[]; humanQueries: string[]; runs: ChatRun[];
}
export function entity(state: Record<string, unknown>, key: string): Entity {
  const value = state[key];
  if (!value || typeof value !== "object" || typeof (value as Entity).id !== "string") throw new Error(`Missing fixture ${key}`);
  return value as Entity;
}
export const companyPath = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
export async function project(ctx: ChatCatalogContext, name = "Launch", extra: Record<string, unknown> = {}) {
  return ctx.input.api.post<Entity>(`${companyPath(ctx)}/projects`, { name, ...extra });
}
export async function task(ctx: ChatCatalogContext, title: string, projectId: string, extra: Record<string, unknown> = {}) {
  // Backlog fixtures never start provider work. These are prerequisite records, not requested outcomes.
  return ctx.input.api.post<Entity>(`${companyPath(ctx)}/issues`, { title, projectId, status: "backlog", priority: "medium", ...extra });
}
export async function goal(ctx: ChatCatalogContext, title: string, extra: Record<string, unknown> = {}) {
  return ctx.input.api.post<Entity>(`${companyPath(ctx)}/goals`, { title, level: "company", ownerAgentId: ctx.input.fixtures.agent.id, ...extra });
}
export async function putDocument(ctx: ChatCatalogContext, issueId: string, body: string, baseRevisionId: string | null = null) {
  return ctx.input.api.putSensitive<Entity>(`/api/issues/${issueId}/documents/plan`, {
    title: "Website implementation plan", format: "markdown", body, baseRevisionId,
  });
}
export async function observeInternal(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<InternalObservation> {
  await ctx.refreshIssue();
  const { api, fixtures } = ctx.input;
  const [tasks, projects, goals, runs] = await Promise.all([
    api.get<Entity[]>(`${companyPath(ctx)}/issues?includeAgentCreatedTasks=true&limit=1000`),
    api.get<Entity[]>(`${companyPath(ctx)}/projects?includeArchived=true`),
    api.get<Entity[]>(`${companyPath(ctx)}/goals`), ctx.allRuns(),
  ]);
  const source = ctx.issue();
  const chat = source ? await api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`) : [];
  const replies = chat.filter(row => row.authorAgentId === fixtures.agent.id && runs.some(run => run.id === row.createdByRunId));
  const target = state.task ? entity(state, "task") : undefined;
  const comments = target ? await api.get<Entity[]>(`/api/issues/${target.id}/comments?order=asc`) : [];
  const companyActivity = await api.get<Entity[]>(`${companyPath(ctx)}/activity?limit=1000`);
  const taskActivity = target ? await api.get<Entity[]>(`/api/issues/${target.id}/activity`) : [];
  const activity = [...new Map([...companyActivity, ...taskActivity].map(row => [row.id, row])).values()];
  const renderedLinkEvidence = source ? await collectConversationLinks(ctx.input.page, {
    origin: api.baseURL, companyId: fixtures.company.id, companyPrefix: fixtures.company.issuePrefix,
    sourceId: source.id, leadId: fixtures.agent.id, comments: chat, runs, projects, activity,
  }) : [];
  const links = [...new Set(renderedLinkEvidence.map(link => link.href))];
  const documents: Entity[] = []; const revisions: Entity[] = [];
  if (target) {
    for (const summary of await api.get<Entity[]>(`/api/issues/${target.id}/documents`)) {
      const endpoint = `/api/issues/${target.id}/documents/${encodeURIComponent(summary.key!)}`;
      documents.push(await api.get<Entity>(endpoint));
      revisions.push(...await api.get<Entity[]>(`${endpoint}/revisions`));
    }
  }
  return { scenarioId: ctx.scenario.id, origin: api.baseURL, companyId: fixtures.company.id, leadId: fixtures.agent.id,
    state, tasks: tasks.filter(row => row.id !== source?.id), projects, goals, runs, comments, activity, documents, revisions,
    renderedLinkEvidence, humanQueries: chat.filter(row => !row.authorAgentId).map(row => row.body ?? ""), reply: replies.map(row => row.body ?? "").join("\n"), links };
}
export function hasLink(o: InternalObservation, kind: "issues" | "projects" | "goals", row: Entity): boolean {
  return o.links.some(href => {
    try {
      const url = new URL(href, o.origin);
      if (url.origin !== new URL(o.origin).origin) return false;
      const parts = url.pathname.split("/").map(decodeURIComponent); const index = parts.indexOf(kind);
      return index >= 0 && [row.id, row.identifier, row.urlKey].includes(parts[index + 1]);
    } catch { return false; }
  });
}
export function observation(value: unknown): InternalObservation | undefined {
  if (!value || typeof value !== "object") return;
  const o = value as InternalObservation;
  if (!o.state || ![o.tasks, o.projects, o.goals, o.comments, o.activity, o.documents, o.revisions, o.links, o.humanQueries, o.runs].every(Array.isArray)
    || typeof o.reply !== "string" || typeof o.origin !== "string" || typeof o.companyId !== "string" || typeof o.leadId !== "string") return;
  return o;
}
export function checks() {
  const rows: Array<{ id: string; passed: boolean; detail: string }> = [];
  return { add(id: string, passed: boolean, detail: string) { rows.push({ id, passed, detail }); },
    result() { return { passed: rows.length > 0 && rows.every(row => row.passed), checks: rows }; } };
}
export function sameTask(before: Entity, after: Entity | undefined, except: readonly string[] = []) {
  return !!after && ["id", "companyId", "title", "description", "projectId", "status", "priority", "assigneeAgentId", "goalId"]
    .filter(key => !except.includes(key)).every(key => before[key as keyof Entity] === after[key as keyof Entity]);
}

/** Follow the exact rendered chat links, check the real result view, and return to the source. */
export async function verifyInternalResult(ctx: ChatCatalogContext, _state: Record<string, unknown>, value: unknown, remainingBudget?: () => number) {
  const options = () => remainingBudget ? { timeout: remainingBudget() } : {};
  const o = observation(value);
  if (!o) throw new Error("Result navigation requires a complete observation");
  const sourceUrl = ctx.input.page.url();
  const candidates: Array<{ kind: "issues" | "projects" | "goals"; row: Entity }> = [
    ...o.tasks.map(row => ({ kind: "issues" as const, row })),
    ...o.projects.map(row => ({ kind: "projects" as const, row })),
    ...o.goals.map(row => ({ kind: "goals" as const, row })),
  ].filter(target => hasLink(o, target.kind, target.row));
  if (!candidates.length) throw new Error("No independently matched result link was rendered");
  for (const { kind, row } of candidates) {
    const href = o.links.find(link => hasLink({ ...o, links: [link] }, kind, row))!;
    const link = internalResultLink(ctx, o, href).first();
    await expect(link).toBeVisible(options());
    await link.click(options());
    await ctx.input.page.waitForURL(url => {
      const parts = url.pathname.split("/").map(decodeURIComponent); const at = parts.indexOf(kind);
      return at >= 0 && [row.id, row.identifier, row.urlKey].includes(parts[at + 1]);
    }, options());
    await expect(ctx.input.page.getByRole("heading", { name: row.title ?? row.name!, exact: true }).first()).toBeVisible(options());
    await ctx.input.evidence(`chat-catalog-opened-${kind}-${row.id}.json`, { id: row.id, kind, url: ctx.input.page.url(), title: row.title ?? row.name });
    await ctx.input.page.goto(sourceUrl, { waitUntil: "domcontentloaded", ...options() });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(options());
    remainingBudget?.();
  }
}

export function internalResultLink(ctx: ChatCatalogContext, o: InternalObservation, href: string) {
  const receipt = o.renderedLinkEvidence?.find(link => link.href === href);
  if (!receipt) throw new Error("Result navigation requires current-conversation rendered-link custody");
  return conversationLinkLocator(ctx.input.page, receipt);
}
