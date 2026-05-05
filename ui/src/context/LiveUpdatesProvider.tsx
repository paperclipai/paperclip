import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { Agent, Issue, IssueComment, LiveEvent } from "@paperclipai/shared";
import type { RunForIssue } from "../api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import type { CompanyUserDirectoryResponse } from "../api/access";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { useCompany } from "./CompanyContext";
import type { ToastInput } from "./ToastContext";
import { useToastActions } from "./ToastContext";
import { upsertIssueCommentInPages } from "../lib/optimistic-issue-comments";
import { clearIssueExecutionRun, removeLiveRunById } from "../lib/optimistic-issue-runs";
import { queryKeys } from "../lib/queryKeys";
import { toCompanyRelativePath } from "../lib/company-routes";
import { useLocation } from "../lib/router";

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

type LiveUpdatesSocketLike = {
  readyState: number;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null;
  close: (code?: number, reason?: string) => void;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function resolveAgentName(
  queryClient: QueryClient,
  companyId: string,
  agentId: string,
): string | null {
  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  if (!agents) return null;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? null;
}

function resolveUserName(
  queryClient: QueryClient,
  companyId: string,
  userId: string,
): string | null {
  const directory = queryClient.getQueryData<CompanyUserDirectoryResponse>(
    queryKeys.access.companyUserDirectory(companyId),
  );
  if (!directory) return null;
  const entry = directory.users.find((u) => u.principalId === userId);
  return entry?.user?.name?.trim() || entry?.user?.email?.trim() || null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function resolveActorLabel(
  queryClient: QueryClient,
  companyId: string,
  actorType: string | null,
  actorId: string | null,
): string {
  if (actorType === "agent" && actorId) {
    return resolveAgentName(queryClient, companyId, actorId) ?? `Agent ${shortId(actorId)}`;
  }
  if (actorType === "system") return "System";
  if (actorType === "user" && actorId) {
    return resolveUserName(queryClient, companyId, actorId) ?? "Board";
  }
  return "Someone";
}

interface IssueToastContext {
  ref: string;
  title: string | null;
  label: string;
  href: string;
}

interface VisibleRouteOptions {
  isForegrounded?: boolean;
}

interface VisibleIssueRouteContext {
  routeIssueRef: string;
  issueRefs: Set<string>;
  assigneeAgentId: string | null;
  runIds: Set<string>;
}

function resolveIssueQueryRefs(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): string[] {
  const refs = new Set<string>([issueId]);
  const detailIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId));
  const listIssues = queryClient.getQueryData<Issue[]>(queryKeys.issues.list(companyId));
  const detailsIdentifier =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier);

  if (detailsIdentifier) refs.add(detailsIdentifier);

  if (detailIssue?.id) refs.add(detailIssue.id);
  if (detailIssue?.identifier) refs.add(detailIssue.identifier);

  const listIssue = listIssues?.find((issue) => {
    if (issue.id === issueId) return true;
    if (issue.identifier && issue.identifier === issueId) return true;
    if (detailsIdentifier && issue.identifier === detailsIdentifier) return true;
    return false;
  });
  if (listIssue?.id) refs.add(listIssue.id);
  if (listIssue?.identifier) refs.add(listIssue.identifier);

  return Array.from(refs);
}

function resolveIssueToastContext(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): IssueToastContext {
  const issueRefs = resolveIssueQueryRefs(queryClient, companyId, issueId, details);
  const detailIssue = issueRefs
    .map((ref) => queryClient.getQueryData<Issue>(queryKeys.issues.detail(ref)))
    .find((issue): issue is Issue => !!issue);
  const listIssue = queryClient
    .getQueryData<Issue[]>(queryKeys.issues.list(companyId))
    ?.find((issue) => issueRefs.some((ref) => issue.id === ref || issue.identifier === ref));
  const cachedIssue = detailIssue ?? listIssue ?? null;
  const ref =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier) ??
    cachedIssue?.identifier ??
    `Issue ${shortId(issueId)}`;
  const title =
    readString(details?.title) ??
    readString(details?.issueTitle) ??
    cachedIssue?.title ??
    null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    href: `/issues/${cachedIssue?.identifier ?? issueId}`,
  };
}

function isPageForegrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return true;
}

function resolveVisibleIssueRouteContext(
  queryClient: QueryClient,
  pathname: string,
  options?: VisibleRouteOptions,
): VisibleIssueRouteContext | null {
  const isForegrounded = options?.isForegrounded ?? isPageForegrounded();
  if (!isForegrounded) return null;

  const relativePath = toCompanyRelativePath(pathname);
  const segments = relativePath.split("/").filter(Boolean);
  if (segments[0] !== "issues" || !segments[1]) return null;

  const issueRef = decodeURIComponent(segments[1]);
  const issue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueRef)) ?? null;
  const issueRefs = new Set<string>([issueRef]);
  if (issue?.id) issueRefs.add(issue.id);
  if (issue?.identifier) issueRefs.add(issue.identifier);

  const runIds = new Set<string>();
  const activeRun = queryClient.getQueryData<ActiveRunForIssue | null>(queryKeys.issues.activeRun(issueRef));
  const liveRuns = queryClient.getQueryData<LiveRunForIssue[]>(queryKeys.issues.liveRuns(issueRef)) ?? [];
  const linkedRuns = queryClient.getQueryData<RunForIssue[]>(queryKeys.issues.runs(issueRef)) ?? [];

  if (activeRun?.id) runIds.add(activeRun.id);
  for (const run of liveRuns) {
    if (run.id) runIds.add(run.id);
  }
  for (const run of linkedRuns) {
    if (run.runId) runIds.add(run.runId);
  }

  return {
    routeIssueRef: issueRef,
    issueRefs,
    assigneeAgentId: issue?.assigneeAgentId ?? null,
    runIds,
  };
}

function buildIssueRefsForPayload(entityId: string, details: Record<string, unknown> | null): Set<string> {
  const refs = new Set<string>([entityId]);
  const identifier = readString(details?.identifier) ?? readString(details?.issueIdentifier);
  if (identifier) refs.add(identifier);
  return refs;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function shouldSuppressActivityToastForVisibleIssue(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  if (entityType !== "issue" || !entityId) return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, readRecord(payload.details)));
}

function shouldSuppressRunStatusToastForVisibleIssue(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const runId = readString(payload.runId);
  if (runId && context.runIds.has(runId)) return true;

  const agentId = readString(payload.agentId);
  return !!agentId && !!context.assigneeAgentId && agentId === context.assigneeAgentId;
}

function invalidateVisibleIssueRunQueries(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const matchesVisibleIssue =
    (runId !== null && context.runIds.has(runId)) ||
    (!!agentId && !!context.assigneeAgentId && agentId === context.assigneeAgentId);
  if (!matchesVisibleIssue) return false;

  const status = readString(payload.status);
  if (runId && status && TERMINAL_RUN_STATUSES.has(status)) {
    queryClient.setQueryData(
      queryKeys.issues.liveRuns(context.routeIssueRef),
      (current: LiveRunForIssue[] | undefined) => removeLiveRunById(current, runId),
    );
    queryClient.setQueryData(
      queryKeys.issues.activeRun(context.routeIssueRef),
      (current: ActiveRunForIssue | null | undefined) => (current?.id === runId ? null : current),
    );
    queryClient.setQueryData(
      queryKeys.issues.detail(context.routeIssueRef),
      (current: Issue | undefined) => clearIssueExecutionRun(current, runId),
    );
  }

  queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(context.routeIssueRef) });
  queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(context.routeIssueRef) });
  queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(context.routeIssueRef) });
  queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(context.routeIssueRef) });
  queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(context.routeIssueRef) });
  return true;
}

function shouldSuppressAgentStatusToastForVisibleIssue(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context?.assigneeAgentId) return false;

  const agentId = readString(payload.agentId);
  return !!agentId && agentId === context.assigneeAgentId;
}

function shouldDeferIssueRefetchForVisibleAgentActivity(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const actorType = readString(payload.actorType);
  const action = readString(payload.action);
  const details = readRecord(payload.details);

  if (entityType !== "issue" || !entityId) return false;
  if (actorType !== "agent" && actorType !== "system") return false;
  if (action !== "issue.updated") return false;
  if (readString(details?.source) === "comment") return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details));
}

function shouldDeferVisibleIssueCommentActivity(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);

  if (entityType !== "issue" || !entityId) return false;
  if (action !== "issue.comment_added") return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details));
}

async function hydrateVisibleIssueComment(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
) {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const commentId = readString(details?.commentId);

  if (entityType !== "issue" || action !== "issue.comment_added" || !commentId) return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const entityId = readString(payload.entityId);
  if (!entityId || !overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details))) {
    return false;
  }

  try {
    const comment = await issuesApi.getComment(context.routeIssueRef, commentId);
    queryClient.setQueryData<InfiniteData<IssueComment[], string | null> | undefined>(
      queryKeys.issues.comments(context.routeIssueRef),
      (current) => {
        if (!current) {
          return {
            pages: [[comment]],
            pageParams: [null],
          };
        }

        return {
          ...current,
          pages: upsertIssueCommentInPages(current.pages, comment),
        };
      },
    );
    return true;
  } catch {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(context.routeIssueRef) });
    return false;
  }
}

const ISSUE_TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);
const AGENT_TOAST_STATUSES = new Set(["error"]);
const RUN_TOAST_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

function describeIssueUpdate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const changes: string[] = [];
  if (typeof details.status === "string") changes.push(`status -> ${details.status.replace(/_/g, " ")}`);
  if (typeof details.priority === "string") changes.push(`priority -> ${details.priority}`);
  if (typeof details.assigneeAgentId === "string" || typeof details.assigneeUserId === "string") {
    changes.push("reassigned");
  } else if (details.assigneeAgentId === null || details.assigneeUserId === null) {
    changes.push("unassigned");
  }
  if (details.reopened === true) {
    const from = readString(details.reopenedFrom);
    changes.push(from ? `reopened from ${from.replace(/_/g, " ")}` : "reopened");
  }
  if (typeof details.title === "string") changes.push("title changed");
  if (typeof details.description === "string") changes.push("description changed");
  if (changes.length > 0) return changes.join(", ");
  return null;
}

function buildActivityToast(
  queryClient: QueryClient,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const actorId = readString(payload.actorId);
  const actorType = readString(payload.actorType);

  if (entityType !== "issue" || !entityId || !action || !ISSUE_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const issue = resolveIssueToastContext(queryClient, companyId, entityId, details);
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);
  const isSelfActivity =
    (actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
    (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId);
  if (isSelfActivity) return null;

  if (action === "issue.created") {
    return {
      title: `${actor} created ${issue.ref}`,
      body: issue.title ? truncate(issue.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${issue.ref}`, href: issue.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  if (action === "issue.updated") {
    if (readString(details?.source) === "comment") {
      // Comment-driven updates emit a paired comment event; show one combined toast on the comment event.
      return null;
    }
    const changeDesc = describeIssueUpdate(details);
    const body = changeDesc
      ? issue.title
        ? `${truncate(issue.title, 64)} - ${changeDesc}`
        : changeDesc
      : issue.title
        ? truncate(issue.title, 96)
        : issue.label;
    return {
      title: `${actor} updated ${issue.ref}`,
      body: truncate(body, 100),
      tone: "info",
      action: { label: `View ${issue.ref}`, href: issue.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  const commentId = readString(details?.commentId);
  const bodySnippet = readString(details?.bodySnippet);
  const reopened = details?.reopened === true;
  const updated = details?.updated === true;
  const reopenedFrom = readString(details?.reopenedFrom);
  const reopenedLabel = reopened
    ? reopenedFrom
      ? `reopened from ${reopenedFrom.replace(/_/g, " ")}`
      : "reopened"
    : null;
  const title = reopened
    ? `${actor} reopened and commented on ${issue.ref}`
    : updated
      ? `${actor} commented and updated ${issue.ref}`
      : `${actor} commented on ${issue.ref}`;
  const body = bodySnippet
    ? reopenedLabel
      ? `${reopenedLabel} - ${bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")}`
      : bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")
    : reopenedLabel
      ? issue.title
        ? `${reopenedLabel} - ${issue.title}`
        : reopenedLabel
      : issue.title ?? undefined;
  return {
    title,
    body: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: { label: `View ${issue.ref}`, href: issue.href },
    dedupeKey: `activity:${action}:${entityId}:${commentId ?? "na"}`,
  };
}

function buildJoinRequestToast(
  payload: Record<string, unknown>,
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const entityId = readString(payload.entityId);
  const details = readRecord(payload.details);

  if (entityType !== "join_request" || !action || !entityId) return null;
  if (action !== "join.requested" && action !== "join.request_replayed") return null;

  const requestType = readString(details?.requestType);
  const label = requestType === "agent" ? "Agent" : "Someone";

  return {
    title: `${label} wants to join`,
    body: "A new join request is waiting for approval.",
    tone: "info",
    action: { label: "View inbox", href: "/inbox/mine" },
    dedupeKey: `join-request:${entityId}`,
  };
}

function buildAgentStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
  queryClient: QueryClient,
  companyId: string,
): ToastInput | null {
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!agentId || !status || !AGENT_TOAST_STATUSES.has(status)) return null;

  const tone = status === "error" ? "error" : "info";
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const title =
    status === "running"
      ? `${name} started`
      : `${name} errored`;

  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  const agent = agents?.find((a) => a.id === agentId);
  const body = agent?.title ?? undefined;

  return {
    title,
    body,
    tone,
    action: { label: "View agent", href: `/agents/${agentId}` },
    dedupeKey: `agent-status:${agentId}:${status}`,
  };
}

function buildRunStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
): ToastInput | null {
  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!runId || !agentId || !status || !RUN_TOAST_STATUSES.has(status)) return null;

  const error = readString(payload.error);
  const triggerDetail = readString(payload.triggerDetail);
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const tone = status === "succeeded" ? "success" : status === "cancelled" ? "warn" : "error";
  const statusLabel =
    status === "succeeded" ? "succeeded"
      : status === "failed" ? "failed"
        : status === "timed_out" ? "timed out"
          : "cancelled";
  const title = `${name} run ${statusLabel}`;

  let body: string | undefined;
  if (error) {
    body = truncate(error, 100);
  } else if (triggerDetail) {
    body = `Trigger: ${triggerDetail}`;
  }

  return {
    title,
    body,
    tone,
    ttlMs: status === "succeeded" ? 5000 : 7000,
    action: { label: "View run", href: `/agents/${agentId}/runs/${runId}` },
    dedupeKey: `run-status:${runId}:${status}`,
  };
}

function invalidateHeartbeatQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const agentId = readString(payload.agentId);
  if (agentId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, agentId) });
  }
}

function invalidateActivityQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
  options?: { pathname?: string; isForegrounded?: boolean },
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const actorType = readString(payload.actorType);
  const actorId = readString(payload.actorId);

  if (entityType === "issue") {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
    if (entityId) {
      const details = readRecord(payload.details);
      const selfCommentActivity =
        ((action === "issue.comment_added") ||
          (action === "issue.updated" && readString(details?.source) === "comment")) &&
        ((actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
          (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId));
      const visibleIssueAgentActivity =
        !!options?.pathname &&
        shouldDeferIssueRefetchForVisibleAgentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const visibleIssueCommentActivity =
        !!options?.pathname &&
        shouldDeferVisibleIssueCommentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const issueRefs = resolveIssueQueryRefs(queryClient, companyId, entityId, details);
      for (const ref of issueRefs) {
        const invalidationOptions =
          (selfCommentActivity || visibleIssueAgentActivity || visibleIssueCommentActivity)
            ? { refetchType: "inactive" as const }
            : undefined;
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref), ...invalidationOptions });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref), ...invalidationOptions });
        if (action === "issue.comment_added") {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref), ...invalidationOptions });
        }
        if (action?.startsWith("issue.thread_interaction_")) {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(ref), ...invalidationOptions });
        }
      }
    }
    return;
  }

  if (entityType === "agent") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    if (entityId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(entityId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, entityId) });
    }
    return;
  }

  if (entityType === "project") {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(entityId) });
    return;
  }

  if (entityType === "goal") {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(entityId) });
    return;
  }

  if (entityType === "approval") {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    return;
  }

  if (entityType === "join_request") {
    queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
    return;
  }

  if (entityType === "cost_event") {
    queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.usageByProvider(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.usageWindowSpend(companyId) });
    // usageQuotaWindows is intentionally excluded: quota windows come from external provider
    // apis on a 5-minute poll and do not change in response to cost events logged by agents
    return;
  }

  if (entityType === "routine" || entityType === "routine_trigger" || entityType === "routine_run") {
    queryClient.invalidateQueries({ queryKey: ["routines"] });
    return;
  }

  if (entityType === "company") {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }
}

interface ToastGate {
  cooldownHits: Map<string, number[]>;
  suppressUntil: number;
}

function shouldSuppressToast(gate: ToastGate, category: string): boolean {
  const now = Date.now();
  if (now < gate.suppressUntil) return true;

  const hits = gate.cooldownHits.get(category);
  if (!hits) return false;

  const recent = hits.filter((t) => now - t < TOAST_COOLDOWN_WINDOW_MS);
  gate.cooldownHits.set(category, recent);
  return recent.length >= TOAST_COOLDOWN_MAX;
}

function recordToastHit(gate: ToastGate, category: string) {
  const now = Date.now();
  const hits = gate.cooldownHits.get(category) ?? [];
  hits.push(now);
  gate.cooldownHits.set(category, hits);
}

function gatedPushToast(
  gate: ToastGate,
  pushToast: (toast: ToastInput) => string | null,
  category: string,
  toast: ToastInput,
) {
  if (shouldSuppressToast(gate, category)) return;
  const id = pushToast(toast);
  if (id !== null) recordToastHit(gate, category);
}

function handleLiveEvent(
  queryClient: QueryClient,
  expectedCompanyId: string,
  pathname: string,
  event: LiveEvent,
  pushToast: (toast: ToastInput) => string | null,
  gate: ToastGate,
  currentActor: { userId: string | null; agentId: string | null },
) {
  if (event.companyId !== expectedCompanyId) return;

  const nameOf = (id: string) => resolveAgentName(queryClient, expectedCompanyId, id);
  const payload = event.payload ?? {};
  if (event.type === "heartbeat.run.log") {
    return;
  }

  if (event.type === "heartbeat.run.queued" || event.type === "heartbeat.run.status") {
    invalidateHeartbeatQueries(queryClient, expectedCompanyId, payload);
    invalidateVisibleIssueRunQueries(queryClient, pathname, payload);
    if (event.type === "heartbeat.run.status") {
      const toast = buildRunStatusToast(payload, nameOf);
      if (
        toast &&
        !shouldSuppressRunStatusToastForVisibleIssue(queryClient, pathname, payload)
      ) {
        gatedPushToast(gate, pushToast, "run-status", toast);
      }
    }
    return;
  }

  if (event.type === "heartbeat.run.event") {
    return;
  }

  if (event.type === "agent.status") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(expectedCompanyId) });
    const agentId = readString(payload.agentId);
    if (agentId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    const toast = buildAgentStatusToast(payload, nameOf, queryClient, expectedCompanyId);
    if (
      toast &&
      !shouldSuppressAgentStatusToastForVisibleIssue(queryClient, pathname, payload)
    ) {
      gatedPushToast(gate, pushToast, "agent-status", toast);
    }
    return;
  }

  if (event.type === "activity.logged") {
    invalidateActivityQueries(queryClient, expectedCompanyId, payload, currentActor, { pathname });
    if (shouldDeferVisibleIssueCommentActivity(queryClient, pathname, payload)) {
      void hydrateVisibleIssueComment(queryClient, pathname, payload);
    }
    const action = readString(payload.action);
    const toast =
      buildActivityToast(queryClient, expectedCompanyId, payload, currentActor) ??
      buildJoinRequestToast(payload);
    if (
      toast &&
      !shouldSuppressActivityToastForVisibleIssue(queryClient, pathname, payload)
    ) {
      gatedPushToast(gate, pushToast, `activity:${action ?? "unknown"}`, toast);
    }
  }
}

function resolveLiveCompanyId(
  selectedCompanyId: string | null,
  selectedCompanyLiveId: string | null,
): string | null {
  return selectedCompanyId && selectedCompanyId === selectedCompanyLiveId
    ? selectedCompanyId
    : null;
}

function resetSocketHandlers(target: LiveUpdatesSocketLike) {
  target.onopen = null;
  target.onmessage = null;
  target.onerror = null;
  target.onclose = null;
}

function closeSocketQuietly(target: LiveUpdatesSocketLike | null, reason: string) {
  if (!target) return;

  if (target.readyState === SOCKET_CONNECTING) {
    // Let the handshake complete and then close. Calling close() while the
    // socket is still CONNECTING is what triggers the noisy browser error.
    target.onopen = () => {
      resetSocketHandlers(target);
      target.close(1000, reason);
    };
    target.onmessage = null;
    target.onerror = () => undefined;
    target.onclose = null;
    return;
  }

  resetSocketHandlers(target);

  if (target.readyState === SOCKET_OPEN) {
    target.close(1000, reason);
  }
}

export const __liveUpdatesTestUtils = {
  buildAgentStatusToast,
  buildRunStatusToast,
  closeSocketQuietly,
  hydrateVisibleIssueComment,
  invalidateActivityQueries,
  invalidateVisibleIssueRunQueries,
  resolveLiveCompanyId,
  shouldDeferIssueRefetchForVisibleAgentActivity,
  shouldDeferVisibleIssueCommentActivity,
  shouldSuppressActivityToastForVisibleIssue,
  shouldSuppressRunStatusToastForVisibleIssue,
  shouldSuppressAgentStatusToastForVisibleIssue,
};

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const location = useLocation();
  const gateRef = useRef<ToastGate>({ cooldownHits: new Map(), suppressUntil: 0 });
  const pathnameRef = useRef(location.pathname);
  const { data: session, status: sessionStatus } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const socketAuthKey = session?.session?.id ?? currentUserId ?? "signed_out";
  const liveCompanyId = resolveLiveCompanyId(selectedCompanyId, selectedCompany?.id ?? null);
  const canConnectSocket = sessionStatus === "success" && session !== null && liveCompanyId !== null;
  const currentActorRef = useRef<{ userId: string | null; agentId: string | null }>({
    userId: currentUserId,
    agentId: null,
  });

  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    currentActorRef.current = {
      userId: currentUserId,
      agentId: null,
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!canConnectSocket || !liveCompanyId) return;

    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectAttempt += 1;
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(liveCompanyId)}/events/ws`;
      const nextSocket = new WebSocket(url);
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (closed || socket !== nextSocket) {
          closeSocketQuietly(nextSocket, "stale_connection");
          return;
        }
        if (reconnectAttempt > 0) {
          gateRef.current.suppressUntil = Date.now() + RECONNECT_SUPPRESS_MS;
        }
        reconnectAttempt = 0;
      };

      nextSocket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;

        try {
          const parsed = JSON.parse(raw) as LiveEvent;
          handleLiveEvent(queryClient, liveCompanyId, pathnameRef.current, parsed, pushToast, gateRef.current, {
            userId: currentActorRef.current.userId,
            agentId: currentActorRef.current.agentId,
          });
        } catch {
          // Ignore non-JSON payloads.
        }
      };

      nextSocket.onerror = () => {
        // Wait for onclose to drive the reconnect. Self-closing here is what
        // produces the "closed before connection established" browser noise.
      };

      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = null;
        if (closed) return;
        scheduleReconnect();
      };
    };

    // Delay initial connect slightly so React StrictMode's double-invoke
    // cleanup fires before the WebSocket is created, avoiding the
    // "WebSocket closed before connection established" dev-mode error.
    const connectTimer = window.setTimeout(connect, 0);

    return () => {
      closed = true;
      window.clearTimeout(connectTimer);
      clearReconnect();
      const activeSocket = socket;
      socket = null;
      closeSocketQuietly(activeSocket, "provider_unmount");
    };
  }, [queryClient, liveCompanyId, pushToast, canConnectSocket, socketAuthKey]);

  return <>{children}</>;
}
