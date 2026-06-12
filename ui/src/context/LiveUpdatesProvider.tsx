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
import { buildSameOriginWebSocketUrl } from "../lib/websocket-url";

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
// Coalesce LiveEvent-driven invalidations within this window. Bumped from
// 250 ms after a live measurement on /BLO/inbox/mine showed events arriving
// at a median 286 ms gap — ~36 ms past the old window — so 0/81 consecutive
// invalidations were being collapsed and the bare-key inbox query stampeded
// to 82 fetches in 83 s with median request duration 35 s (pg pool fully
// saturated). At 1000 ms the same workload collapses ~70/82 events.
const INVALIDATION_COALESCE_MS = 1000;

type RefetchType = "active" | "inactive" | "none" | "all";

interface InvalidationCoalescer {
  /** Invalidate by exact or prefix queryKey. Coalesces with same key+options. */
  byKey(opts: { queryKey: readonly unknown[]; exact?: boolean; refetchType?: RefetchType }): void;
  /**
   * Invalidate via a predicate. Coalesces by `predicateKey` (a stable string
   * identifier supplied by the caller, since predicate function references
   * differ across event handler invocations).
   */
  byPredicate(predicateKey: string, predicate: (q: { queryKey: readonly unknown[] }) => boolean, refetchType?: RefetchType): void;
  /** Drop pending tasks (e.g. on unmount). */
  cancel(): void;
}

function createInvalidationCoalescer(queryClient: QueryClient, debounceMs = INVALIDATION_COALESCE_MS): InvalidationCoalescer {
  type ExactTask = { queryKey: readonly unknown[]; exact?: boolean; refetchType?: RefetchType };
  type PredicateTask = { predicate: (q: { queryKey: readonly unknown[] }) => boolean; refetchType?: RefetchType };
  const exact = new Map<string, ExactTask>();
  const predicate = new Map<string, PredicateTask>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // refetchType "inactive" / "none" never starts a network request, so the
  // in-flight check is only meaningful for the "active" path (the default).
  function isActive(rt?: RefetchType) {
    return rt === undefined || rt === "active";
  }

  function flush() {
    timer = null;
    const exactEntries = Array.from(exact.entries());
    const predicateEntries = Array.from(predicate.entries());
    exact.clear();
    predicate.clear();
    let deferred = false;
    for (const [k, t] of exactEntries) {
      if (
        isActive(t.refetchType) &&
        queryClient.isFetching({ queryKey: t.queryKey as unknown[], exact: t.exact }) > 0
      ) {
        // Skip this cycle — a fetch is already in flight for this key. Re-queue
        // the task so the next event (or this same task on the next tick) lands
        // *after* the in-flight fetch completes, instead of stacking another
        // refetch on top and saturating the pool.
        exact.set(k, t);
        deferred = true;
        continue;
      }
      queryClient.invalidateQueries({ queryKey: t.queryKey as unknown[], exact: t.exact, refetchType: t.refetchType });
    }
    for (const [k, t] of predicateEntries) {
      if (
        isActive(t.refetchType) &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryClient.isFetching({ predicate: t.predicate as any }) > 0
      ) {
        predicate.set(k, t);
        deferred = true;
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryClient.invalidateQueries({ predicate: t.predicate as any, refetchType: t.refetchType });
    }
    if (deferred) schedule();
  }
  function schedule() {
    if (timer === null) timer = setTimeout(flush, debounceMs);
  }
  return {
    byKey(opts) {
      const key = `${JSON.stringify(opts.queryKey)}|${opts.exact ? "exact" : "prefix"}|${opts.refetchType ?? "active"}`;
      exact.set(key, { queryKey: opts.queryKey, exact: opts.exact, refetchType: opts.refetchType });
      schedule();
    },
    byPredicate(predicateKey, predicateFn, refetchType) {
      const key = `${predicateKey}|${refetchType ?? "active"}`;
      predicate.set(key, { predicate: predicateFn, refetchType });
      schedule();
    },
    cancel() {
      exact.clear();
      predicate.clear();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

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
  if (actorId === "linear-webhook") return "Linear";
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
    `Task ${shortId(issueId)}`;
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
    for (const issueRef of context.issueRefs) {
      queryClient.setQueryData(
        queryKeys.issues.liveRuns(issueRef),
        (current: LiveRunForIssue[] | undefined) => removeLiveRunById(current, runId),
      );
      queryClient.setQueryData(
        queryKeys.issues.activeRun(issueRef),
        (current: ActiveRunForIssue | null | undefined) => (current?.id === runId ? null : current),
      );
      queryClient.setQueryData(
        queryKeys.issues.detail(issueRef),
        (current: Issue | undefined) => clearIssueExecutionRun(current, runId),
      );
    }
  }

  for (const issueRef of context.issueRefs) {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueRef) });
  }
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
const ISSUE_DOCUMENT_ACTIVITY_ACTIONS = new Set([
  "issue.document_created",
  "issue.document_updated",
  "issue.document_restored",
  "issue.document_deleted",
]);
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
  coalescer: InvalidationCoalescer,
  companyId: string,
  payload: Record<string, unknown>,
) {
  coalescer.byKey({ queryKey: queryKeys.liveRuns(companyId) });
  coalescer.byKey({ queryKey: queryKeys.heartbeats(companyId) });
  coalescer.byKey({ queryKey: queryKeys.agents.list(companyId) });
  // Summary queries: many heartbeat events fire per second when several agents
  // are active. Mark stale only; rely on each query's own refetchInterval (15s
  // for sidebarBadges) or window-focus refetch to pick up the fresh data.
  // Without this, every event would force an immediate refetch and the same
  // companyId's /sidebar-badges, /dashboard, /costs URLs would be hammered
  // tens of times per second.
  coalescer.byKey({ queryKey: queryKeys.dashboard(companyId), refetchType: "none" });
  coalescer.byKey({ queryKey: queryKeys.costs(companyId), refetchType: "none" });
  coalescer.byKey({ queryKey: queryKeys.sidebarBadges(companyId), refetchType: "none" });

  const agentId = readString(payload.agentId);
  if (agentId) {
    coalescer.byKey({ queryKey: queryKeys.agents.detail(agentId) });
    coalescer.byKey({ queryKey: queryKeys.heartbeats(companyId, agentId) });
  }
}

function invalidateActivityQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  coalescer: InvalidationCoalescer,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
  options?: { pathname?: string; isForegrounded?: boolean },
) {
  coalescer.byKey({ queryKey: queryKeys.activity(companyId) });
  // Same rationale as in invalidateHeartbeatQueries: dashboard and sidebar
  // badges are summary surfaces that don't need a refetch per activity event.
  coalescer.byKey({ queryKey: queryKeys.dashboard(companyId), refetchType: "none" });
  coalescer.byKey({ queryKey: queryKeys.sidebarBadges(companyId), refetchType: "none" });

  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const actorType = readString(payload.actorType);
  const actorId = readString(payload.actorId);
  const details = readRecord(payload.details);

  if (action?.startsWith("resource_membership.")) {
    const targetUserId = readString(details?.userId);
    if (!targetUserId || targetUserId === currentActor.userId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.resourceMemberships.mine(companyId) });
    }
  }

  if (entityType === "issue") {
    // Earlier this fired `invalidateQueries({ queryKey: queryKeys.issues.list(companyId) })`
    // which prefix-matches every `["issues", companyId, …]` key — meaning the
    // Inbox queries (mine-by-me / touched-by-me / unread-touched-by-me), the
    // bare list key shared by Dashboard / MyIssues / CommandPalette, AND the
    // suffixed Issues / Routines / AgentDetail keys — all triggered an immediate
    // refetch on every issue-activity event, regardless of the explicit
    // `refetchType: "none"` calls below (those run after the default-active
    // invalidation has already kicked off the refetch). On a busy dashboard
    // load this produced 8× the unbounded /api/companies/<id>/issues fetch
    // (1.28 MB each) and 25× the inbox /issues fetch (273 KB each), ~26 MB
    // duplicate downloads in seconds and a stalled UI.
    //
    // Now: use a predicate that targets the suffixed keys only — the Issues
    // and Routines pages still refresh — and explicitly mark the bare /
    // inbox keys stale via `refetchType: "none"`. Those views all rely on
    // staleTime + tab-focus / next-mount to refresh, so they stay correct
    // without a synchronous refetch storm.
    coalescer.byPredicate(
      `issues-suffixed-active:${companyId}`,
      (query) => {
        const key = query.queryKey;
        if (key[0] !== "issues" || key[1] !== companyId) return false;
        if (key.length < 3) return false; // bare list key — handled below with refetchType: "none"
        const variant = key[2];
        if (variant === "mine-by-me" || variant === "touched-by-me" || variant === "unread-touched-by-me") {
          return false; // inbox-badge keys — handled below with refetchType: "none"
        }
        return true;
      },
    );
    coalescer.byKey({ queryKey: queryKeys.issues.list(companyId), exact: true, refetchType: "none" });
    coalescer.byKey({ queryKey: queryKeys.issues.listMineByMe(companyId), refetchType: "none" });
    coalescer.byKey({ queryKey: queryKeys.issues.listTouchedByMe(companyId), refetchType: "none" });
    coalescer.byKey({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId), refetchType: "none" });
    if (entityId) {
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
        const refetchType = (selfCommentActivity || visibleIssueAgentActivity || visibleIssueCommentActivity)
          ? "inactive" as const
          : undefined;
        coalescer.byKey({ queryKey: queryKeys.issues.detail(ref), refetchType });
        coalescer.byKey({ queryKey: queryKeys.issues.activity(ref), refetchType });
        if (action === "issue.comment_added") {
          coalescer.byKey({ queryKey: queryKeys.issues.comments(ref), refetchType });
        }
        if (action && ISSUE_DOCUMENT_ACTIVITY_ACTIONS.has(action)) {
          const documentKey = readString(details?.key);
          coalescer.byKey({ queryKey: queryKeys.issues.documents(ref), refetchType });
          if (documentKey) {
            coalescer.byKey({ queryKey: queryKeys.issues.document(ref, documentKey), refetchType });
            coalescer.byKey({ queryKey: queryKeys.issues.documentRevisions(ref, documentKey), refetchType });
          } else {
            coalescer.byKey({ queryKey: ["issues", "document", ref], refetchType });
            coalescer.byKey({ queryKey: ["issues", "document-revisions", ref], refetchType });
          }
        }
        if (action?.startsWith("issue.thread_interaction_")) {
          coalescer.byKey({ queryKey: queryKeys.issues.interactions(ref), refetchType });
        }
      }
    }
    return;
  }

  if (entityType === "agent") {
    coalescer.byKey({ queryKey: queryKeys.agents.list(companyId) });
    coalescer.byKey({ queryKey: queryKeys.org(companyId) });
    if (entityId) {
      coalescer.byKey({ queryKey: queryKeys.agents.detail(entityId) });
      coalescer.byKey({ queryKey: queryKeys.heartbeats(companyId, entityId) });
    }
    return;
  }

  if (entityType === "project") {
    coalescer.byKey({ queryKey: queryKeys.projects.list(companyId) });
    if (entityId) coalescer.byKey({ queryKey: queryKeys.projects.detail(entityId) });
    return;
  }

  if (entityType === "goal") {
    coalescer.byKey({ queryKey: queryKeys.goals.list(companyId) });
    if (entityId) coalescer.byKey({ queryKey: queryKeys.goals.detail(entityId) });
    return;
  }

  if (entityType === "approval") {
    coalescer.byKey({ queryKey: queryKeys.approvals.list(companyId) });
    return;
  }

  if (entityType === "join_request") {
    coalescer.byKey({ queryKey: queryKeys.access.joinRequests(companyId) });
    return;
  }

  if (entityType === "cost_event") {
    coalescer.byKey({ queryKey: queryKeys.costs(companyId) });
    coalescer.byKey({ queryKey: queryKeys.usageByProvider(companyId) });
    coalescer.byKey({ queryKey: queryKeys.usageWindowSpend(companyId) });
    // usageQuotaWindows is intentionally excluded: quota windows come from external provider
    // apis on a 5-minute poll and do not change in response to cost events logged by agents
    return;
  }

  if (entityType === "routine" || entityType === "routine_trigger" || entityType === "routine_run") {
    coalescer.byKey({ queryKey: ["routines"] });
    return;
  }

  if (entityType === "company") {
    coalescer.byKey({ queryKey: queryKeys.companies.all });
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
  coalescer: InvalidationCoalescer,
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
    invalidateHeartbeatQueries(coalescer, expectedCompanyId, payload);
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
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(expectedCompanyId), refetchType: "none" });
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
    invalidateActivityQueries(queryClient, coalescer, expectedCompanyId, payload, currentActor, { pathname });
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

// Real coalescer factory exposed for unit tests so the in-flight defer +
// debounce semantics can be exercised without a full React tree.
export const __createInvalidationCoalescerForTests = createInvalidationCoalescer;

// Synchronous passthrough coalescer for unit tests — delegates straight to
// queryClient.invalidateQueries so tests can assert exact options without
// dealing with the debounce. Production paths use createInvalidationCoalescer.
export function __makePassthroughCoalescerForTests(
  queryClient: { invalidateQueries: (opts: unknown) => unknown },
): InvalidationCoalescer {
  return {
    byKey: (opts) => { queryClient.invalidateQueries(opts); },
    byPredicate: (_key, predicate, refetchType) => {
      queryClient.invalidateQueries({ predicate, refetchType });
    },
    cancel: () => {},
  };
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
  const coalescerRef = useRef<InvalidationCoalescer | null>(null);
  if (coalescerRef.current === null) coalescerRef.current = createInvalidationCoalescer(queryClient);
  useEffect(() => () => coalescerRef.current?.cancel(), []);
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
      const url = buildSameOriginWebSocketUrl(
        `/api/companies/${encodeURIComponent(liveCompanyId)}/events/ws`,
      );
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
          handleLiveEvent(queryClient, coalescerRef.current!, liveCompanyId, pathnameRef.current, parsed, pushToast, gateRef.current, {
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
