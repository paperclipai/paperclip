/**
 * Sync logic between Linear issues and Paperclip issues.
 * Manages link state in plugin state storage and handles
 * bidirectional status + comment syncing.
 */

import type { PluginContext, Issue } from "@paperclipai/plugin-sdk";

type IssueStatus = Issue["status"];
import { STATE_KEYS } from "./constants.js";
import * as linear from "./linear.js";
import {
  absolutizePaperclipMarkdownLinks,
  stripPaperclipProjectBacklink,
} from "./markdown.js";

export interface IssueLink {
  paperclipIssueId: string;
  paperclipCompanyId: string;
  linearIssueId: string;
  linearIdentifier: string;
  linearUrl: string;
  syncDirection: "bidirectional" | "linear-to-paperclip" | "paperclip-to-linear";
  lastSyncAt: string;
  lastLinearStateType: string;
  lastLinearStateName?: string | null;
  lastCommentSyncAt: string | null;
}

export type ProjectDriftSyncResult = "updated" | "unchanged" | "unavailable" | "failed";

export function isHostWriteUnavailableError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("missing, expired, or unknown invocation scope")
    || message.includes("not allowed to perform")
    || message.includes("CapabilityDeniedError")
    || message.includes("InvocationScopeDeniedError");
}

export function isPaperclipIssueNotFoundError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("Issue not found");
}

function isLinearIssueLinkConflictError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("Linear issue link conflict")
    || message.includes("Linear issue already linked");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err)) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.error === "string") return err.error;
  }
  return String(err);
}

async function hostLinearIssueLinkAlreadyMatches(
  ctx: PluginContext,
  params: {
    paperclipIssueId: string;
    paperclipCompanyId: string;
    linearIssueId: string;
  },
): Promise<boolean> {
  const getByLinearIssueId = ctx.issues.getByLinearIssueId;
  if (typeof getByLinearIssueId !== "function") return false;

  try {
    const hostLinkedIssue = await getByLinearIssueId.call(ctx.issues, {
      linearIssueId: params.linearIssueId,
      companyId: params.paperclipCompanyId,
    });
    return hostLinkedIssue?.id === params.paperclipIssueId;
  } catch (err) {
    ctx.logger.warn("Failed to verify existing host Linear issue link after conflict", {
      paperclipIssueId: params.paperclipIssueId,
      linearIssueId: params.linearIssueId,
      error: String(err),
    });
    return false;
  }
}

function linkStateKey(paperclipIssueId: string): string {
  return `${STATE_KEYS.linkPrefix}${paperclipIssueId}`;
}

function linearStateKey(linearIssueId: string): string {
  return `${STATE_KEYS.linearPrefix}${linearIssueId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssueLink(value: unknown): value is IssueLink {
  return isRecord(value)
    && typeof value.paperclipIssueId === "string"
    && typeof value.paperclipCompanyId === "string"
    && typeof value.linearIssueId === "string"
    && typeof value.linearIdentifier === "string"
    && typeof value.linearUrl === "string"
    && typeof value.syncDirection === "string";
}

export async function getLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });
  if (!isIssueLink(raw)) return null;
  return raw;
}

export async function getLinkByLinear(
  ctx: PluginContext,
  linearIssueId: string,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linearStateKey(linearIssueId),
  });
  if (!raw) return null;
  const paperclipIssueId = String(raw);
  const link = await getLink(ctx, paperclipIssueId);
  if (!link || link.linearIssueId !== linearIssueId) return null;
  return link;
}

export async function createLink(
  ctx: PluginContext,
  params: {
    paperclipIssueId: string;
    paperclipCompanyId: string;
    linearIssueId: string;
    linearIdentifier: string;
    linearUrl: string;
    linearStateType: string;
    syncDirection: IssueLink["syncDirection"];
  },
): Promise<IssueLink> {
  const link: IssueLink = {
    paperclipIssueId: params.paperclipIssueId,
    paperclipCompanyId: params.paperclipCompanyId,
    linearIssueId: params.linearIssueId,
    linearIdentifier: params.linearIdentifier,
    linearUrl: params.linearUrl,
    syncDirection: params.syncDirection,
    lastSyncAt: new Date().toISOString(),
    lastLinearStateType: params.linearStateType,
    lastLinearStateName: null,
    lastCommentSyncAt: null,
  };

  const linkLinearIssue = ctx.issues.linkLinearIssue;
  if (typeof linkLinearIssue === "function") {
    try {
      await linkLinearIssue.call(ctx.issues, {
        issueId: params.paperclipIssueId,
        companyId: params.paperclipCompanyId,
        linearIssueId: params.linearIssueId,
        linearIdentifier: params.linearIdentifier,
      });
    } catch (err) {
      if (isHostWriteUnavailableError(err)) {
        ctx.logger.warn("Host Linear issue link write unavailable; falling back to plugin state only", {
          paperclipIssueId: params.paperclipIssueId,
          linearIssueId: params.linearIssueId,
          error: String(err),
        });
      } else if (
        isLinearIssueLinkConflictError(err)
        && await hostLinearIssueLinkAlreadyMatches(ctx, params)
      ) {
        ctx.logger.warn("Host Linear issue link already exists; repairing plugin state only", {
          paperclipIssueId: params.paperclipIssueId,
          linearIssueId: params.linearIssueId,
          linearIdentifier: params.linearIdentifier,
          error: String(err),
        });
      } else {
        throw err;
      }
    }
  } else {
    ctx.logger.warn("Host Linear issue link write unavailable; falling back to plugin state only", {
      paperclipIssueId: params.paperclipIssueId,
      linearIssueId: params.linearIssueId,
      error: "ctx.issues.linkLinearIssue is not available",
    });
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(params.paperclipIssueId) },
    link,
  );

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linearStateKey(params.linearIssueId) },
    params.paperclipIssueId,
  );

  return link;
}

export async function removeLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<boolean> {
  const link = await getLink(ctx, paperclipIssueId);
  if (!link) return false;

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linearStateKey(link.linearIssueId),
  });

  return true;
}

async function updateLink(ctx: PluginContext, link: IssueLink): Promise<void> {
  link.lastSyncAt = new Date().toISOString();
  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(link.paperclipIssueId) },
    link,
  );
}

function normalizedStateName(stateName: string | null | undefined): string {
  return (stateName ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function linearStateToPaperclipStatus(stateType: string, stateName?: string | null): IssueStatus {
  const normalizedName = normalizedStateName(stateName);
  if (normalizedName === "in review" || normalizedName === "review") return "in_review";
  if (normalizedName === "in progress" || normalizedName === "doing") return "in_progress";
  if (normalizedName === "todo" || normalizedName === "to do") return "todo";
  if (normalizedName === "blocked") return "blocked";
  if (normalizedName === "backlog") return "backlog";
  if (normalizedName === "done") return "done";
  if (normalizedName === "canceled" || normalizedName === "cancelled") return "cancelled";

  switch (stateType) {
    case "completed": return "done";
    case "canceled":
    case "cancelled": return "cancelled";
    case "started": return "in_progress";
    case "unstarted": return "todo";
    default: return "backlog";
  }
}

const PAPERCLIP_TO_LINEAR_STATE: Record<string, { names: string[]; fallbackType: string }> = {
  backlog: { names: ["backlog"], fallbackType: "backlog" },
  todo: { names: ["todo", "to do"], fallbackType: "unstarted" },
  in_progress: { names: ["in progress", "doing"], fallbackType: "started" },
  in_review: { names: ["in review", "review"], fallbackType: "started" },
  blocked: { names: ["blocked", "todo", "to do"], fallbackType: "unstarted" },
  done: { names: ["done"], fallbackType: "completed" },
  cancelled: { names: ["canceled", "cancelled"], fallbackType: "canceled" },
};

function linearStateForPaperclipStatus(
  status: string,
  states: Array<{ id: string; name: string; type: string }>,
): { id: string; name: string; type: string } | null {
  const mapping = PAPERCLIP_TO_LINEAR_STATE[status] ?? PAPERCLIP_TO_LINEAR_STATE.todo;
  for (const name of mapping.names) {
    const match = states.find((state) => normalizedStateName(state.name) === name);
    if (match) return match;
  }
  return states.find((state) => state.type === mapping.fallbackType) ?? null;
}

function linearPriorityToPaperclip(priority: number): "critical" | "high" | "medium" | "low" {
  const map: Record<number, "critical" | "high" | "medium" | "low"> = {
    0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
  };
  return map[priority] ?? "medium";
}

async function resolvePaperclipUserIdForLinearAssignee(
  ctx: PluginContext,
  assignee: linear.LinearIssue["assignee"],
): Promise<string | undefined> {
  const normalized = assignee?.email?.trim().toLowerCase();
  if (!normalized) return undefined;

  const stateKey = `linear-user-by-email:${normalized}`;
  const cached = await ctx.state.get({ scopeKind: "instance", stateKey });
  if (typeof cached === "string" && cached.length > 0) return cached;
  if (cached === "") return undefined;

  try {
    const user = await ctx.users.findByEmail(normalized);
    const userId = user?.id ?? null;
    await ctx.state.set({ scopeKind: "instance", stateKey }, userId ?? "");
    return userId ?? undefined;
  } catch (err) {
    ctx.logger.warn(`Failed to resolve user by email ${normalized}: ${err}`);
    return undefined;
  }
}

export async function syncFromLinear(
  ctx: PluginContext,
  link: IssueLink,
  linearIssue: linear.LinearIssue,
): Promise<void> {
  if (link.syncDirection === "paperclip-to-linear") return;

  const patch: Record<string, unknown> = {};
  let linkNeedsUpdate = false;

  // Sync status
  const newStateType = linearIssue.state.type;
  const newStateName = linearIssue.state.name ?? null;
  if (newStateType !== link.lastLinearStateType || newStateName !== (link.lastLinearStateName ?? null)) {
    const status = linearStateToPaperclipStatus(newStateType, newStateName);
    if (status === "in_progress") {
      const assigneeUserId = await resolvePaperclipUserIdForLinearAssignee(ctx, linearIssue.assignee);
      if (assigneeUserId) {
        patch.assigneeUserId = assigneeUserId;
        patch.status = status;
        link.lastLinearStateType = newStateType;
        link.lastLinearStateName = newStateName;
      } else {
        ctx.logger.info(
          `Skipped in_progress status sync for ${linearIssue.identifier}: Linear assignee is not mapped to a Paperclip user`,
        );
      }
    } else {
      patch.status = status;
      link.lastLinearStateType = newStateType;
      link.lastLinearStateName = newStateName;
    }
    linkNeedsUpdate = true;
  }

  // Sync priority if available
  if (linearIssue.priority !== undefined) {
    patch.priority = linearPriorityToPaperclip(linearIssue.priority);
  }

  // Sync title if available
  if (linearIssue.title) {
    patch.title = linearIssue.title;
  }

  const linearProjectId = linearIssue.project?.id ?? null;
  if (linearProjectId) {
    const projectLink = await getProjectLinkByLinear(ctx, linearProjectId);
    if (projectLink && projectLink.paperclipCompanyId === link.paperclipCompanyId) {
      patch.projectId = projectLink.paperclipProjectId;
    } else if (projectLink) {
      ctx.logger.warn(
        `Skipped project sync for ${link.linearIdentifier}: Linear project ${linearProjectId} maps to company ${projectLink.paperclipCompanyId}, not ${link.paperclipCompanyId}`,
      );
    }
  }

  if (Object.keys(patch).length === 0) {
    if (linkNeedsUpdate) await updateLink(ctx, link);
    return;
  }

  try {
    await ctx.issues.update(link.paperclipIssueId, patch as Parameters<typeof ctx.issues.update>[1], link.paperclipCompanyId);
  } catch (err) {
    if (!("projectId" in patch)) throw err;
    const { projectId: _projectId, ...withoutProject } = patch;
    await ctx.issues.update(
      link.paperclipIssueId,
      withoutProject as Parameters<typeof ctx.issues.update>[1],
      link.paperclipCompanyId,
    );
    ctx.logger.warn(
      `Synced ${link.linearIdentifier} without projectId because moving Paperclip issue ${link.paperclipIssueId} failed: ${err}`,
    );
  }
  await updateLink(ctx, link);

  ctx.logger.info(
    `Synced Linear ${link.linearIdentifier} -> Paperclip (${Object.keys(patch).join(", ")})`,
  );
}

function paperclipPriorityToLinear(priority: string): number {
  const map: Record<string, number> = {
    critical: 1, high: 2, medium: 3, low: 4,
  };
  return map[priority] ?? 0;
}

const FALLBACK_LINEAR_LABEL_COLOR = "#6366f1";

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLinearLabelColor(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && /^#[0-9a-fA-F]{6}$/.test(trimmed)
    ? trimmed
    : FALLBACK_LINEAR_LABEL_COLOR;
}

async function resolveLinearIssueLabelIdsForPaperclipLabels(
  ctx: PluginContext,
  companyId: string,
  paperclipLabelIds: string[],
  token: string,
  teamId: string,
): Promise<string[]> {
  const dedupedPaperclipLabelIds = [...new Set(paperclipLabelIds)];
  if (dedupedPaperclipLabelIds.length === 0) return [];

  const paperclipLabels = await ctx.labels.list(companyId);
  const paperclipLabelsById = new Map(paperclipLabels.map((label) => [label.id, label]));
  const requestedLabels = dedupedPaperclipLabelIds
    .map((labelId) => paperclipLabelsById.get(labelId) ?? null)
    .filter((label): label is NonNullable<typeof label> => label !== null);
  if (requestedLabels.length !== dedupedPaperclipLabelIds.length) {
    const missing = dedupedPaperclipLabelIds.filter((labelId) => !paperclipLabelsById.has(labelId));
    ctx.logger.warn(
      `Skipping ${missing.length} Paperclip labels during Linear sync because they were not found in company ${companyId}`,
    );
  }
  if (requestedLabels.length === 0) return [];

  const linearLabels = await linear.listIssueLabels(ctx.http.fetch.bind(ctx.http), token, {
    teamId,
    limit: 500,
  });
  const linearLabelsByName = new Map(
    linearLabels.map((label) => [normalizeLabelName(label.name), label]),
  );
  const linearLabelIds: string[] = [];

  for (const paperclipLabel of requestedLabels) {
    const normalizedName = normalizeLabelName(paperclipLabel.name);
    const existing = linearLabelsByName.get(normalizedName);
    if (existing) {
      linearLabelIds.push(existing.id);
      continue;
    }

    try {
      const created = await linear.createIssueLabel(ctx.http.fetch.bind(ctx.http), token, {
        name: paperclipLabel.name,
        color: normalizeLinearLabelColor(paperclipLabel.color),
        teamId,
      });
      linearLabelsByName.set(normalizedName, created);
      linearLabelIds.push(created.id);
    } catch (err) {
      const refreshed = await linear.listIssueLabels(ctx.http.fetch.bind(ctx.http), token, {
        teamId,
        query: paperclipLabel.name,
        limit: 500,
      });
      const racedLabel = refreshed.find((label) => normalizeLabelName(label.name) === normalizedName);
      if (racedLabel) {
        linearLabelsByName.set(normalizedName, racedLabel);
        linearLabelIds.push(racedLabel.id);
        continue;
      }
      throw err;
    }
  }

  return linearLabelIds;
}

export interface SyncChanges {
  status?: string;
  priority?: string;
  title?: string;
  description?: string;
  estimate?: number | null;
  dueDate?: string | null;
  projectId?: string | null;
  labelIds?: string[];
}

export interface SyncToLinearOptions {
  baseUrl: string | null;
  companyPrefix?: string | null;
  force?: boolean;
}

export async function syncToLinear(
  ctx: PluginContext,
  link: IssueLink,
  changes: SyncChanges,
  token: string,
  teamId: string,
  paperclipLinkOptions?: SyncToLinearOptions,
): Promise<void> {
  if (link.syncDirection === "linear-to-paperclip") return;

  // Feedback loop prevention: if the last sync was from Linear within 5 seconds,
  // don't push back — this update was likely triggered by an inbound webhook.
  const timeSinceSync = Date.now() - new Date(link.lastSyncAt).getTime();
  if (!paperclipLinkOptions?.force && timeSinceSync < 5000) {
    ctx.logger.info(`Skipping sync to Linear for ${link.linearIdentifier} — last synced ${timeSinceSync}ms ago (likely webhook echo)`);
    return;
  }

  const linearUpdate: Record<string, unknown> = {};
  const synced: string[] = [];

  // Status → Linear state
  if (changes.status) {
    const states = await linear.getWorkflowStates(ctx.http.fetch.bind(ctx.http), token, teamId);
    const targetState = linearStateForPaperclipStatus(changes.status, states);
    if (
      targetState
      && (
        targetState.type !== link.lastLinearStateType
        || targetState.name !== (link.lastLinearStateName ?? null)
      )
    ) {
      linearUpdate.stateId = targetState.id;
      link.lastLinearStateType = targetState.type;
      link.lastLinearStateName = targetState.name;
      synced.push(`status:${targetState.name}`);
    }
  }

  // Priority → Linear priority
  if (changes.priority) {
    linearUpdate.priority = paperclipPriorityToLinear(changes.priority);
    synced.push(`priority:${changes.priority}`);
  }

  // Title → Linear title
  if (changes.title) {
    linearUpdate.title = changes.title;
    synced.push("title");
  }

  // Description → Linear description
  if (changes.description !== undefined) {
    linearUpdate.description = absolutizePaperclipMarkdownLinks(
      changes.description ?? "",
      paperclipLinkOptions?.baseUrl ?? null,
      paperclipLinkOptions?.companyPrefix ?? null,
    );
    synced.push("description");
  }

  // Estimate → Linear estimate
  if (changes.estimate !== undefined) {
    linearUpdate.estimate = changes.estimate;
    synced.push(`estimate:${changes.estimate ?? "none"}`);
  }

  // Due date → Linear dueDate
  if (changes.dueDate !== undefined) {
    linearUpdate.dueDate = changes.dueDate;
    synced.push(`dueDate:${changes.dueDate ?? "none"}`);
  }

  // Paperclip project move → Linear project move
  if (changes.projectId !== undefined) {
    const targetPaperclipProjectId = typeof changes.projectId === "string"
      ? changes.projectId.trim()
      : "";

    if (!targetPaperclipProjectId) {
      linearUpdate.projectId = null;
      synced.push("project:none");
    } else {
      const projectLink = await getProjectLink(ctx, targetPaperclipProjectId);
      if (!projectLink) {
        ctx.logger.warn(
          `Skipping Linear project move for ${link.linearIdentifier}: Paperclip project ${targetPaperclipProjectId} is not linked to Linear`,
        );
      } else if (projectLink.paperclipCompanyId !== link.paperclipCompanyId) {
        ctx.logger.warn(
          `Skipping Linear project move for ${link.linearIdentifier}: target project belongs to another company`,
        );
      } else {
        linearUpdate.projectId = projectLink.linearProjectId;
        synced.push(`project:${projectLink.linearProjectName ?? projectLink.linearProjectId}`);
      }
    }
  }

  // Paperclip labels -> Linear issue labels
  if (changes.labelIds !== undefined) {
    const linearLabelIds = await resolveLinearIssueLabelIdsForPaperclipLabels(
      ctx,
      link.paperclipCompanyId,
      Array.isArray(changes.labelIds) ? changes.labelIds : [],
      token,
      teamId,
    );
    linearUpdate.labelIds = linearLabelIds;
    synced.push(`labels:${linearLabelIds.length}`);
  }

  if (Object.keys(linearUpdate).length === 0) return;

  await linear.updateIssue(ctx.http.fetch.bind(ctx.http), token, link.linearIssueId, linearUpdate);
  await updateLink(ctx, link);

  ctx.logger.info(
    `Synced Paperclip -> Linear ${link.linearIdentifier} (${synced.join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// Project link storage & sync
// ---------------------------------------------------------------------------

export interface ProjectLink {
  paperclipProjectId: string;
  paperclipCompanyId: string;
  linearProjectId: string;
  linearProjectName: string;
  syncDirection: "bidirectional" | "linear-to-paperclip" | "paperclip-to-linear";
  lastSyncAt: string;
  lastLinearState: string;
  lastLinearDescription?: string | null;
}

function projectLinkStateKey(paperclipProjectId: string): string {
  return `${STATE_KEYS.projectLinkPrefix}${paperclipProjectId}`;
}

function linearProjectStateKey(linearProjectId: string): string {
  return `${STATE_KEYS.projectLinearPrefix}${linearProjectId}`;
}

function isProjectLink(value: unknown): value is ProjectLink {
  return isRecord(value)
    && typeof value.paperclipProjectId === "string"
    && typeof value.paperclipCompanyId === "string"
    && typeof value.linearProjectId === "string"
    && typeof value.linearProjectName === "string"
    && typeof value.syncDirection === "string";
}

export async function getProjectLink(
  ctx: PluginContext,
  paperclipProjectId: string,
): Promise<ProjectLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: projectLinkStateKey(paperclipProjectId),
  });
  if (!isProjectLink(raw)) return null;
  return raw;
}

export async function getProjectLinkByLinear(
  ctx: PluginContext,
  linearProjectId: string,
): Promise<ProjectLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linearProjectStateKey(linearProjectId),
  });
  if (!raw) return null;
  const paperclipProjectId = String(raw);
  const link = await getProjectLink(ctx, paperclipProjectId);
  if (!link || link.linearProjectId !== linearProjectId) return null;
  return link;
}

export async function createProjectLink(
  ctx: PluginContext,
  params: {
    paperclipProjectId: string;
    paperclipCompanyId: string;
    linearProjectId: string;
    linearProjectName: string;
    linearState: string;
    syncDirection: ProjectLink["syncDirection"];
  },
): Promise<ProjectLink> {
  const link: ProjectLink = {
    paperclipProjectId: params.paperclipProjectId,
    paperclipCompanyId: params.paperclipCompanyId,
    linearProjectId: params.linearProjectId,
    linearProjectName: params.linearProjectName,
    syncDirection: params.syncDirection,
    lastSyncAt: new Date().toISOString(),
    lastLinearState: params.linearState,
    lastLinearDescription: null,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: projectLinkStateKey(params.paperclipProjectId) },
    link,
  );

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linearProjectStateKey(params.linearProjectId) },
    params.paperclipProjectId,
  );

  return link;
}

export async function removeProjectLink(
  ctx: PluginContext,
  paperclipProjectId: string,
): Promise<boolean> {
  const link = await getProjectLink(ctx, paperclipProjectId);
  if (!link) return false;

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: projectLinkStateKey(paperclipProjectId),
  });

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linearProjectStateKey(link.linearProjectId),
  });

  return true;
}

async function updateProjectLink(ctx: PluginContext, link: ProjectLink): Promise<void> {
  link.lastSyncAt = new Date().toISOString();
  await ctx.state.set(
    { scopeKind: "instance", stateKey: projectLinkStateKey(link.paperclipProjectId) },
    link,
  );
}

// Linear project states: "planned", "started", "paused", "completed", "canceled"
// Paperclip project statuses: "backlog", "planned", "in_progress", "completed", "cancelled"
export function linearProjectStateToPaperclip(state: string): string {
  const map: Record<string, string> = {
    planned: "planned", backlog: "backlog",
    started: "in_progress", "in progress": "in_progress",
    paused: "backlog",
    completed: "completed", done: "completed",
    canceled: "cancelled", cancelled: "cancelled",
  };
  return map[state.toLowerCase()] ?? "backlog";
}

export function paperclipProjectStateToLinear(status: string): string {
  const map: Record<string, string> = {
    backlog: "planned", planned: "planned",
    in_progress: "started", active: "started",
    completed: "completed",
    cancelled: "canceled",
  };
  return map[status] ?? "planned";
}

export async function syncProjectFromLinear(
  ctx: PluginContext,
  link: ProjectLink,
  linearProject: { id: string; name: string; description: string | null; state: string },
): Promise<ProjectDriftSyncResult> {
  if (link.syncDirection === "paperclip-to-linear") return "unchanged";

  const patch: Record<string, unknown> = {};

  if (linearProject.name && linearProject.name !== link.linearProjectName) {
    patch.name = linearProject.name;
    link.linearProjectName = linearProject.name;
  }

  if (linearProject.description !== undefined) {
    const linearDescription = stripPaperclipProjectBacklink(linearProject.description) ?? null;
    const hasSeenDescription = Object.prototype.hasOwnProperty.call(link, "lastLinearDescription");
    if (!hasSeenDescription || linearDescription !== (link.lastLinearDescription ?? null)) {
      patch.description = linearDescription ?? undefined;
      link.lastLinearDescription = linearDescription;
    }
  }

  const newState = linearProject.state?.toLowerCase() ?? link.lastLinearState;
  if (newState !== link.lastLinearState) {
    patch.status = linearProjectStateToPaperclip(newState);
    link.lastLinearState = newState;
  }

  if (Object.keys(patch).length === 0) return "unchanged";

  // Try the typed client first; fall back to ctx.rpc.call (newer SDK escape
  // hatch) so this works on plugin installs whose pinned SDK predates the
  // typed projects.update wrapper. Pre-rpc SDKs throw the original
  // "ctx.projects.update is not a function" — we catch and surface a
  // clearer log so operators know an SDK bump is needed.
  const rpcCall = (ctx as any).rpc?.call as
    | (<T>(method: string, params?: unknown) => Promise<T>)
    | undefined;
  try {
    if (typeof (ctx.projects as any)?.update === "function") {
      await (ctx.projects as any).update(link.paperclipProjectId, patch as any, link.paperclipCompanyId);
    } else if (rpcCall) {
      await rpcCall("projects.update", {
        projectId: link.paperclipProjectId,
        patch,
        companyId: link.paperclipCompanyId,
      });
    } else {
      ctx.logger.warn(
        `Skipping project drift for ${link.linearProjectName ?? link.paperclipProjectId}: ` +
          `installed plugin SDK exposes neither ctx.projects.update nor ctx.rpc.call.`,
      );
      return "unavailable";
    }
  } catch (err) {
    ctx.logger.warn(
      `Failed to sync Linear project drift to Paperclip: ${err}`,
    );
    return isHostWriteUnavailableError(err) ? "unavailable" : "failed";
  }

  await updateProjectLink(ctx, link);

  ctx.logger.info(
    `Synced Linear project -> Paperclip (${Object.keys(patch).join(", ")})`,
  );
  return "updated";
}

export async function syncProjectToLinear(
  ctx: PluginContext,
  link: ProjectLink,
  changes: { name?: string; description?: string; status?: string },
  token: string,
  paperclipLinkOptions?: { baseUrl: string | null; companyPrefix?: string | null },
): Promise<void> {
  if (link.syncDirection === "linear-to-paperclip") return;

  // Feedback loop prevention
  const timeSinceSync = Date.now() - new Date(link.lastSyncAt).getTime();
  if (timeSinceSync < 5000) {
    ctx.logger.info(`Skipping project sync to Linear — last synced ${timeSinceSync}ms ago`);
    return;
  }

  const linearUpdate: Record<string, string> = {};
  const synced: string[] = [];

  if (changes.name) {
    linearUpdate.name = changes.name;
    synced.push("name");
  }

  if (changes.description !== undefined) {
    linearUpdate.description = absolutizePaperclipMarkdownLinks(
      changes.description ?? "",
      paperclipLinkOptions?.baseUrl ?? null,
      paperclipLinkOptions?.companyPrefix ?? null,
    );
    synced.push("description");
  }

  if (changes.status) {
    const linearState = paperclipProjectStateToLinear(changes.status);
    if (linearState !== link.lastLinearState) {
      linearUpdate.state = linearState;
      link.lastLinearState = linearState;
      synced.push(`state:${linearState}`);
    }
  }

  if (Object.keys(linearUpdate).length === 0) return;

  await linear.updateProject(
    ctx.http.fetch.bind(ctx.http), token,
    link.linearProjectId, linearUpdate,
  );
  await updateProjectLink(ctx, link);

  ctx.logger.info(
    `Synced Paperclip project -> Linear ${link.linearProjectName} (${synced.join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// Goal link storage & sync
//
// Paperclip goals are pushed to Linear as Issues inside a dedicated "Company
// Goals" project. Sync is paperclip→linear only — Linear-side edits to these
// issues do not flow back, since goals are first-class in Paperclip.
// ---------------------------------------------------------------------------

export interface GoalLink {
  paperclipGoalId: string;
  paperclipCompanyId: string;
  linearIssueId: string;
  linearIdentifier: string;
  linearUrl: string;
  linearProjectId: string | null;
  lastSyncAt: string;
  lastTitle: string;
  lastStatus: string;
  lastTargetDate: string | null;
  lastLevel: string;
}

function goalLinkStateKey(paperclipGoalId: string): string {
  return `${STATE_KEYS.goalLinkPrefix}${paperclipGoalId}`;
}

function goalLinearStateKey(linearIssueId: string): string {
  return `${STATE_KEYS.goalLinearPrefix}${linearIssueId}`;
}

function copyGoalLink(link: GoalLink): GoalLink {
  return { ...link };
}

export async function getGoalLink(
  ctx: PluginContext,
  paperclipGoalId: string,
): Promise<GoalLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: goalLinkStateKey(paperclipGoalId),
  });
  if (!raw) return null;
  return copyGoalLink(raw as GoalLink);
}

export async function createGoalLink(
  ctx: PluginContext,
  link: GoalLink,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: goalLinkStateKey(link.paperclipGoalId) },
    copyGoalLink(link),
  );
  await ctx.state.set(
    { scopeKind: "instance", stateKey: goalLinearStateKey(link.linearIssueId) },
    link.paperclipGoalId,
  );
}

export async function updateGoalLink(
  ctx: PluginContext,
  link: GoalLink,
): Promise<void> {
  const previous = await getGoalLink(ctx, link.paperclipGoalId);
  link.lastSyncAt = new Date().toISOString();

  await ctx.state.set(
    { scopeKind: "instance", stateKey: goalLinkStateKey(link.paperclipGoalId) },
    copyGoalLink(link),
  );

  if (previous && previous.linearIssueId !== link.linearIssueId) {
    await ctx.state.delete({
      scopeKind: "instance",
      stateKey: goalLinearStateKey(previous.linearIssueId),
    });
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: goalLinearStateKey(link.linearIssueId) },
    link.paperclipGoalId,
  );
}

export async function removeGoalLink(
  ctx: PluginContext,
  paperclipGoalId: string,
): Promise<boolean> {
  const link = await getGoalLink(ctx, paperclipGoalId);
  if (!link) return false;

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: goalLinkStateKey(paperclipGoalId),
  });

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: goalLinearStateKey(link.linearIssueId),
  });

  return true;
}

/**
 * Look up a goal link by the Linear-side identifier (issue id or initiative id —
 * the link uses `linearIssueId` for both, distinguished by `linearProjectId === null`
 * for initiatives).
 */
export async function getGoalLinkByLinear(
  ctx: PluginContext,
  linearId: string,
): Promise<GoalLink | null> {
  const goalId = await ctx.state.get({
    scopeKind: "instance",
    stateKey: goalLinearStateKey(linearId),
  });
  if (!goalId || typeof goalId !== "string") return null;
  const link = await getGoalLink(ctx, goalId);
  if (!link || link.linearIssueId !== linearId) return null;
  return link;
}

/** Map Paperclip goal status → Linear workflow state type. */
export function paperclipGoalStatusToLinearStateType(status: string): string {
  switch (status) {
    case "active": return "started";
    case "achieved": return "completed";
    case "cancelled": return "cancelled";
    default: return "unstarted"; // planned / unknown
  }
}

export type PaperclipGoalStatus = "planned" | "active" | "achieved" | "cancelled";

/**
 * Map a Linear initiative status (case-insensitive) to a Paperclip goal status.
 * Linear initiative statuses include "Planned", "Active", "Completed", "Cancelled",
 * "Paused" — and may arrive in either case via the GraphQL API or webhooks.
 */
export function linearInitiativeStatusToPaperclip(status: string | null | undefined): PaperclipGoalStatus {
  const normalized = (status ?? "").toLowerCase();
  switch (normalized) {
    case "completed": return "achieved";
    case "cancelled":
    case "canceled": return "cancelled";
    case "active":
    case "started":
    case "in progress":
    case "in_progress": return "active";
    default: return "planned";
  }
}

export async function bridgeCommentToLinear(
  ctx: PluginContext,
  link: IssueLink,
  token: string,
  commentBody: string,
  authorName: string,
  paperclipLinkOptions?: { baseUrl: string | null; companyPrefix?: string | null },
): Promise<void> {
  if (link.syncDirection === "linear-to-paperclip") return;
  if (commentBody.includes("[synced from Linear]")) return;
  const safeBody = absolutizePaperclipMarkdownLinks(
    commentBody,
    paperclipLinkOptions?.baseUrl ?? null,
    paperclipLinkOptions?.companyPrefix ?? null,
  );

  await linear.createComment(
    ctx.http.fetch.bind(ctx.http),
    token,
    link.linearIssueId,
    `**${authorName}** [synced from Paperclip]:\n\n${safeBody}`,
  );
}
