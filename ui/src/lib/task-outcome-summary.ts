import type {
  Issue,
  IssueDocumentSummary,
  IssueOverview,
  IssueRelationIssueSummary,
  IssueWorkProduct,
} from "@paperclipai/shared";

/**
 * Result-first task summary model (operator experience, task detail).
 *
 * Everything here is derived from canonical stored records — the issue row
 * (including its explicit `deliveryKind`), its work products (with their
 * recorded summaries), plan/spec documents, child issues, and the shared
 * issue-overview record when available. Nothing is inferred from free-text
 * comments, and raw work-product metadata is never parsed to compete with
 * the shared overview projection: an unknown result stays explicit.
 */

/** Shared contract slice consumed from the Data owner's IssueOverview. */
export type TaskOutcomeOverview = Pick<
  IssueOverview,
  "blocked" | "project" | "parent" | "blocker" | "pullRequests" | "delivery"
>;

export interface TaskOutcomeAncestor {
  id: string;
  identifier: string | null;
  title: string;
}

export interface TaskOutcomeProject {
  id: string;
  name: string;
  urlKey?: string | null;
}

export type TaskOutcomeResultKind =
  | "merged"
  | "done_with_code"
  | "done_noncode"
  | "done_unclassified"
  | "recorded_evidence"
  | "unknown";

export interface TaskOutcomeEvidence {
  label: string;
  title: string;
  detail: string | null;
  href: string | null;
}

export interface TaskOutcomeChild {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

export interface TaskOutcomePullRequest {
  url: string | null;
  number: number | null;
  repository: string | null;
  state: "draft" | "open" | "closed" | "merged" | "unknown";
  stale: boolean;
}

export interface TaskOutcomeDocLink {
  key: string;
  title: string;
  hash: string;
}

export interface TaskOutcomeLink {
  title: string;
  href: string;
}

export interface TaskOutcomeModel {
  currentStatus: Issue["status"];
  requestedText: string | null;
  requestedTruncated: boolean;
  resultKind: TaskOutcomeResultKind;
  /** Explicit branch copy for the result row; null when evidence speaks. */
  resultNote: string | null;
  /** Code vs non-code vs unknown. Unknown is explicit, never a default. */
  workKind: "code" | "noncode" | "unknown";
  evidence: TaskOutcomeEvidence[];
  childrenTotal: number;
  childrenCompleted: number;
  childrenCancelled: number;
  openChildren: TaskOutcomeChild[];
  hasMoreOpenChildren: boolean;
  blockerMessage: string | null;
  blockerOwnerLabel: string | null;
  blockerNextAction: string | null;
  blockerIssue: { id: string; identifier: string | null; title: string } | null;
  /** True only when the shared overview projection supplied PR states. */
  prStateAvailable: boolean;
  /** PR states come solely from the overview projection, never metadata. */
  pullRequests: TaskOutcomePullRequest[];
  parent: { id: string; identifier: string | null; title: string } | null;
  projectName: string | null;
  planDocs: TaskOutcomeDocLink[];
  previews: TaskOutcomeLink[];
  lastEventAt: string | null;
}

export const TASK_OUTCOME_REQUEST_EXCERPT_LIMIT = 280;
export const TASK_OUTCOME_EVIDENCE_DETAIL_LIMIT = 400;
export const TASK_OUTCOME_MAX_OPEN_CHILDREN = 4;
export const TASK_OUTCOME_MAX_EVIDENCE = 6;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}


/**
 * Browser-safe href for stored work-product links. Absolute URLs must be
 * http(s); relative artifact paths pass through. Anything else (javascript:,
 * data:, ftp:, …) is dropped so stored strings can never become a link.
 */
export function taskOutcomeSafeHref(
  value: string | null | undefined,
): string | null {
  const trimmed = asNonEmptyString(value);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, "https://paperclip.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function readMetadataRecord(
  workProduct: Pick<IssueWorkProduct, "metadata">,
): Record<string, unknown> | null {
  const metadata = workProduct.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return metadata as Record<string, unknown>;
}

/** Usable link for a work-product row (mirrors the Artifacts tab fallback). */
export function taskOutcomeWorkProductHref(
  workProduct: Pick<IssueWorkProduct, "url" | "metadata">,
): string | null {
  const direct = taskOutcomeSafeHref(workProduct.url);
  if (direct) return direct;
  const metadata = readMetadataRecord(workProduct);
  if (!metadata) return null;
  for (const key of ["openPath", "url"]) {
    const safe = taskOutcomeSafeHref(metadata[key] as string | null);
    if (safe) return safe;
  }
  return null;
}

function hasCodeWorkProducts(workProducts: readonly IssueWorkProduct[]): boolean {
  return workProducts.some(
    (workProduct) =>
      workProduct.type === "pull_request" ||
      workProduct.type === "branch" ||
      workProduct.type === "commit",
  );
}

function docTitle(doc: Pick<IssueDocumentSummary, "key" | "title">): string {
  if (doc.title?.trim()) return doc.title;
  const words = doc.key.replace(/[-_]+/g, " ").trim();
  if (!words) return doc.key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface BuildTaskOutcomeModelInput {
  issue: Pick<
    Issue,
    | "id"
    | "description"
    | "status"
    | "deliveryKind"
    | "blockedBy"
    | "blockerAttention"
    | "unblockDescriptor"
    | "blockedInboxAttention"
    | "activeRecoveryAction"
    | "planDocument"
    | "legacyPlanDocument"
  >;
  childIssues: readonly Pick<Issue, "id" | "identifier" | "title" | "status">[];
  workProducts: readonly IssueWorkProduct[];
  documents: readonly IssueDocumentSummary[];
  ancestors: readonly TaskOutcomeAncestor[];
  project: TaskOutcomeProject | null;
  overview: TaskOutcomeOverview | null;
}

export function buildTaskOutcomeModel(
  input: BuildTaskOutcomeModelInput,
): TaskOutcomeModel {
  const { issue, childIssues, workProducts, documents, ancestors, project } =
    input;
  const overview = input.overview ?? null;

  const description = issue.description?.trim() || null;
  const requestedTruncated =
    description !== null &&
    description.length > TASK_OUTCOME_REQUEST_EXCERPT_LIMIT;

  const deliveryKind = issue.deliveryKind ?? null;
  const overviewCodeSignals =
    (overview?.pullRequests.length ?? 0) > 0 || overview?.delivery != null;
  const codeSignal = hasCodeWorkProducts(workProducts) || overviewCodeSignals;

  // Merged is a current-outcome claim, not a historical fact: it requires the
  // delivery receipt's merge evidence AND a done task. A reopened task
  // (non-done status) with an old merged PR keeps its merged chips, but its
  // outcome is whatever the current work shows.
  const merged =
    issue.status === "done" &&
    overview?.delivery?.phase === "merged" &&
    (overview?.delivery?.mergedAt ?? null) !== null;

  const isDone = issue.status === "done";
  let resultKind: TaskOutcomeResultKind;
  if (merged) {
    resultKind = "merged";
  } else if (isDone) {
    // Absence of code evidence never proves non-code: unclassified done stays
    // explicit unless the row carries the explicit non_code marker.
    if (deliveryKind === "non_code") {
      resultKind = "done_noncode";
    } else if (deliveryKind === "code" || codeSignal) {
      resultKind = "done_with_code";
    } else {
      resultKind = "done_unclassified";
    }
  } else if (workProducts.length > 0 || overviewCodeSignals) {
    resultKind = "recorded_evidence";
  } else {
    resultKind = "unknown";
  }
  const workKind: TaskOutcomeModel["workKind"] =
    deliveryKind === "code" || codeSignal
      ? "code"
      : deliveryKind === "non_code"
        ? "noncode"
        : "unknown";

  // Evidence is always labelled by its stored source — never a new summary.
  const evidence: TaskOutcomeEvidence[] = [];
  for (const workProduct of workProducts) {
    const summary = workProduct.summary?.trim() || null;
    if (!summary) continue;
    evidence.push({
      label: `Work product · ${workProduct.type.replace(/_/g, " ")}`,
      title: workProduct.title,
      detail: summary,
      href: taskOutcomeWorkProductHref(workProduct),
    });
  }

  // One fallback note per branch so an evidence-less state can never borrow
  // another branch's copy.
  let resultNote: string | null = null;
  if (resultKind === "unknown") {
    resultNote =
      "Nothing is stored as a result — see the conversation below before assuming progress.";
  } else if (resultKind === "done_unclassified") {
    resultNote = "Marked done · delivery evidence not recorded.";
  } else if (evidence.length === 0) {
    if (resultKind === "merged") {
      resultNote = "Delivery records a merge — no stored work-product summaries.";
    } else if (resultKind === "done_with_code") {
      resultNote = "Code work recorded — no stored work-product summaries.";
    } else if (resultKind === "done_noncode") {
      resultNote =
        "Marked done with no code delivery — outcome is the completed task itself.";
    } else if (resultKind === "recorded_evidence") {
      resultNote = "Evidence recorded — no stored result summary. See the evidence links below.";
    }
  }

  // Cancelled is closed, not completed: it never counts toward done and never
  // earns an "all subtasks done" line.
  const completedChildren = childIssues.filter(
    (child) => child.status === "done",
  );
  const cancelledChildren = childIssues.filter(
    (child) => child.status === "cancelled",
  );
  const openChildren = childIssues
    .filter((child) => child.status !== "done" && child.status !== "cancelled")
    .map((child) => ({
      id: child.id,
      identifier: child.identifier,
      title: child.title,
      status: child.status,
    }))
    .sort((a, b) => {
      const aKey = a.identifier ?? a.id;
      const bKey = b.identifier ?? b.id;
      return aKey.localeCompare(bKey, undefined, { numeric: true });
    });
  const visibleOpenChildren = openChildren.slice(
    0,
    TASK_OUTCOME_MAX_OPEN_CHILDREN,
  );

  // Blocker: shared overview first, then the explicit unblock descriptor and
  // sampled blocked-by chain, then the recovery action. All stored values.
  let blockerMessage = overview?.blocker?.message?.trim() || null;
  let blockerOwnerLabel = overview?.blocker?.ownerLabel ?? null;
  let blockerNextAction = overview?.blocker?.nextAction ?? null;
  let blockerIssue: TaskOutcomeModel["blockerIssue"] =
    overview?.blocker?.issues?.[0] ?? null;
  if (!blockerMessage) {
    const descriptor = issue.unblockDescriptor;
    if (descriptor) {
      blockerMessage = descriptor.action?.trim() || null;
      const owner = descriptor.owner;
      blockerOwnerLabel =
        typeof owner === "string"
          ? "Board"
          : "agentId" in owner
            ? "Agent"
            : "userId" in owner
              ? "User"
              : null;
    }
  }
  if (!blockerMessage) {
    blockerMessage =
      issue.blockedInboxAttention?.action.label?.trim() || null;
    if (blockerMessage) {
      blockerOwnerLabel =
        issue.blockedInboxAttention?.owner.label?.trim() || blockerOwnerLabel;
      blockerNextAction =
        issue.blockedInboxAttention?.action.detail?.trim() || blockerNextAction;
    }
  }
  if (!blockerMessage && issue.blockerAttention) {
    const attention = issue.blockerAttention;
    const sample =
      attention.terminalBlocker?.title ??
      attention.sampleBlockerIdentifier ??
      attention.sampleStalledBlockerIdentifier;
    if (sample) {
      blockerMessage = `Waiting on ${sample}`;
    } else if (attention.unresolvedBlockerCount > 0) {
      blockerMessage = `Waiting on ${attention.unresolvedBlockerCount} blocked ${
        attention.unresolvedBlockerCount === 1 ? "task" : "tasks"
      }`;
    }
  }
  if (!blockerMessage && issue.activeRecoveryAction) {
    blockerMessage =
      issue.activeRecoveryAction.cause?.trim() || "Recovery in progress";
    blockerNextAction =
      issue.activeRecoveryAction.nextAction?.trim() || blockerNextAction;
  }
  if (!blockerIssue) {
    const blockedBy: readonly IssueRelationIssueSummary[] =
      issue.blockedBy ?? [];
    const first = blockedBy.find(
      (blocker) =>
        blocker.status !== "done" && blocker.status !== "cancelled",
    );
    blockerIssue = first
      ? { id: first.id, identifier: first.identifier, title: first.title }
      : null;
  }

  // PR states come solely from the shared overview projection. Without it the
  // projection is unavailable — raw work-product rows stay evidence links and
  // never prove merge state.
  const prStateAvailable = overview != null;
  const pullRequests: TaskOutcomePullRequest[] = (
    overview?.pullRequests ?? []
  ).map((pr) => ({
    url: taskOutcomeSafeHref(pr.url),
    number: pr.number,
    repository: pr.repository,
    state: pr.state,
    stale: pr.stale,
  }));

  const parent =
    overview?.parent ??
    (ancestors.length > 0
      ? {
          id: ancestors[0]!.id,
          identifier: ancestors[0]!.identifier,
          title: ancestors[0]!.title,
        }
      : null);
  const projectName = overview?.project?.name ?? project?.name ?? null;

  const planDocs: TaskOutcomeDocLink[] = [];
  const seenDocKeys = new Set<string>();
  const pushDoc = (key: string, title: string | null) => {
    if (seenDocKeys.has(key)) return;
    seenDocKeys.add(key);
    planDocs.push({
      key,
      title: title?.trim() || docTitle({ key, title }),
      hash: `#document-${encodeURIComponent(key)}`,
    });
  };
  // Canonical plan/spec first, then remaining docs.
  for (const doc of documents) {
    if (doc.key === "plan" || doc.key === "specification") {
      pushDoc(doc.key, doc.title);
    }
  }
  if (issue.planDocument && !seenDocKeys.has(issue.planDocument.key)) {
    pushDoc(issue.planDocument.key, issue.planDocument.title);
  }
  for (const doc of documents) {
    if (doc.key === "plan" || doc.key === "specification") continue;
    pushDoc(doc.key, doc.title);
  }
  if (
    issue.legacyPlanDocument &&
    !seenDocKeys.has(issue.legacyPlanDocument.key)
  ) {
    pushDoc(issue.legacyPlanDocument.key, "Plan");
  }

  const previews: TaskOutcomeLink[] = [];
  const seenHrefs = new Set<string>();
  const pushPreview = (title: string, href: string | null) => {
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);
    previews.push({ title, href });
  };
  for (const workProduct of workProducts) {
    if (
      workProduct.type === "preview_url" ||
      workProduct.type === "runtime_service"
    ) {
      pushPreview(
        workProduct.title,
        taskOutcomeWorkProductHref(workProduct),
      );
    }
  }
  for (const pr of pullRequests) {
    if (pr.url) {
      pushPreview(
        pr.number !== null
          ? `PR #${pr.number}`
          : (pr.repository ?? "Pull request"),
        pr.url,
      );
    }
  }
  for (const workProduct of workProducts) {
    if (
      workProduct.type === "artifact" ||
      workProduct.type === "document" ||
      workProduct.type === "pull_request"
    ) {
      pushPreview(
        workProduct.title,
        taskOutcomeWorkProductHref(workProduct),
      );
    }
  }

  return {
    currentStatus: issue.status,
    requestedText: description,
    requestedTruncated,
    resultKind,
    resultNote,
    workKind,
    evidence,
    childrenTotal: childIssues.length,
    childrenCompleted: completedChildren.length,
    childrenCancelled: cancelledChildren.length,
    openChildren: visibleOpenChildren,
    hasMoreOpenChildren: openChildren.length > visibleOpenChildren.length,
    blockerMessage,
    blockerOwnerLabel,
    blockerNextAction,
    blockerIssue,
    prStateAvailable,
    pullRequests,
    parent,
    projectName,
    planDocs,
    previews,
    lastEventAt: overview?.delivery?.lastEventAt ?? null,
  };
}
