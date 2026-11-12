import type { ConnectionApi } from "../connection-target.js";

export interface IsolationTask { id: string; companyId: string; title: string; description: string | null; identifier: string }
export interface IsolationWorkspace { stackId: string; stackSlug: string; companyId: string; origin: string; displayName: string; issuePrefix: string }
export interface CreatedIsolationTask extends IsolationTask {
  createdByAgentId: string | null; createdByUserId: string | null; status: string;
  assigneeAgentId: string | null; assigneeUserId: string | null;
}
export interface IsolationCreateResponse { status: number; contentLeaked: boolean; task: CreatedIsolationTask | null }
export interface IsolationResponse { status: number; contentLeaked: boolean; task: Pick<IsolationTask, "id" | "companyId" | "description"> | null }
/** Authentication and exact secondary fixture ownership stay with the target provider. */
export interface CompanyAccessFixture {
  portalOrigin: string;
  primary: IsolationWorkspace;
  secondary: IsolationWorkspace;
  secondaryApi: ConnectionApi;
  restrictedActors: { primary: { kind: "agent"; id: string; companyId: string }; secondary: { kind: "agent"; id: string; companyId: string } };
  createSecondaryTask(title: string, description: string): Promise<IsolationTask>;
  restrictedRequest(actor: "primary" | "secondary", scope: "primary" | "secondary", method: "GET", issueId: string): Promise<IsolationResponse>;
  restrictedCreate(actor: "primary" | "secondary", scope: "primary" | "secondary", title: string, description: string): Promise<IsolationCreateResponse>;
  revokeCredentials(): Promise<{ revoked: boolean; deniedStatuses: { primary: number; secondary: number } }>;
}

function validOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password; }
  catch { return false; }
}
export function workspacePairMatches(primary: IsolationWorkspace, secondary: IsolationWorkspace): boolean {
  return Boolean(primary.stackId && secondary.stackId && primary.stackSlug && secondary.stackSlug && primary.companyId && secondary.companyId && primary.issuePrefix && secondary.issuePrefix
    && primary.displayName && secondary.displayName && primary.stackId !== secondary.stackId && primary.companyId !== secondary.companyId
    && primary.origin !== secondary.origin && [primary.origin, secondary.origin].every(validOrigin));
}
export function isolationTaskMatches(task: IsolationTask | null | undefined, expected: { id: string; companyId: string; title: string; description: string }): boolean {
  return Boolean(task && task.id === expected.id && task.companyId === expected.companyId && task.title === expected.title && task.description === expected.description);
}
export function restrictedPositiveControl(response: IsolationResponse, expected: { id: string; companyId: string; description: string }): boolean {
  return response.status === 200 && response.task?.id === expected.id && response.task.companyId === expected.companyId && response.task.description === expected.description;
}
/** Reject 404: owner controls must prove the requested foreign resource exists. */
export function restrictedForeignDenied(read: IsolationResponse, write: IsolationResponse, before: IsolationTask, after: IsolationTask): boolean {
  return [read, write].every(response => [401, 403].includes(response.status) && response.task === null && response.contentLeaked === false)
    && before.id === after.id && before.companyId === after.companyId && before.title === after.title && before.description === after.description;
}

/** Accept only shipped entry forms for the exact receipted workspace. */
export function isolationEntryMatches(href: string | null, portalOrigin: string, workspace: IsolationWorkspace): boolean {
  if (!href || !validOrigin(portalOrigin)) return false;
  try {
    const url = new URL(href, portalOrigin);
    if (url.origin !== portalOrigin || url.username || url.password || url.hash) return false;
    const slug = encodeURIComponent(workspace.stackSlug), id = encodeURIComponent(workspace.stackId);
    return new Set([
      `${portalOrigin}/stacks/${slug}/enter`, `${portalOrigin}/orgs/${id}/enter`,
      `${portalOrigin}/v1/stacks/${slug}/entry-redirect`, `${portalOrigin}/v1/stacks/${id}/entry-redirect?by=id`,
    ]).has(url.href);
  } catch { return false; }
}

/** A successful write is a new canonical agent-created task, not an agent edit without a run. */
export function restrictedCreateAllowed(input: {
  response: IsolationCreateResponse; expected: { companyId: string; title: string; description: string; agentId: string };
  before: IsolationTask[]; after: IsolationTask[]; canonical: CreatedIsolationTask | null;
}): boolean {
  const { response, expected, before, after, canonical } = input;
  if (response.status !== 201 || response.contentLeaked !== false || !response.task?.id || before.length !== 0 || after.length !== 1) return false;
  const correct = (task: CreatedIsolationTask | null) => Boolean(task && task.id === response.task!.id
    && isolationTaskMatches(task, { ...expected, id: response.task!.id }) && task.createdByAgentId === expected.agentId
    && task.createdByUserId === null && task.status === "backlog" && task.assigneeAgentId === null && task.assigneeUserId === null);
  return correct(response.task) && correct(canonical) && after[0]?.id === response.task.id
    && after[0].companyId === expected.companyId && after[0].title === expected.title;
}

/** Validate the bounded list projection, which does not include native retry state. */
export function isolationAgentRunIds(value: unknown, actor: { id: string; companyId: string }): string[] | null {
  if (!Array.isArray(value) || value.length >= 100) return null;
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const id = row.runId ?? row.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id) || (row.id != null && row.id !== id || row.runId != null && row.runId !== id)
      || ids.has(id) || row.companyId !== actor.companyId || row.agentId !== actor.id
      || !["succeeded", "failed", "cancelled", "timed_out"].includes(row.status) || row.nativePhase === "retryable_failure") return null;
    ids.add(id);
  }
  return [...ids].sort();
}

/** Detailed terminal state and its persisted revision must stay unchanged. */
export function isolationAgentRunSnapshot(value: unknown, actor: { id: string; companyId: string }): string[] | null {
  const ids = isolationAgentRunIds(value, actor);
  if (!ids) return null;
  const timestamp = (field: unknown) => typeof field === "string" && Number.isFinite(Date.parse(field)) && new Date(field).toISOString() === field;
  const states = new Map<string, string>();
  for (const row of value as Record<string, unknown>[]) {
    if (typeof row.id !== "string" || !timestamp(row.updatedAt) || !timestamp(row.finishedAt)
      || row.startedAt !== null && !timestamp(row.startedAt)) return null;
    if (row.runtimeMode === "native") {
      if (!["committed", "terminal_failure"].includes(row.nativePhase as string) || !timestamp(row.nativePhaseUpdatedAt)) return null;
    } else if (row.runtimeMode !== "legacy" || row.nativePhase !== null || row.nativePhaseUpdatedAt !== null) return null;
    states.set(row.id, JSON.stringify([row.id, row.status, row.runtimeMode, row.nativePhase, row.nativePhaseUpdatedAt,
      row.startedAt, row.finishedAt, row.updatedAt]));
  }
  return ids.map(id => states.get(id)!);
}
