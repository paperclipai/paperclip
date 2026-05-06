/**
 * Cross-issue deliverable view: a rolled-up presentation of an
 * `issue_work_products` row with `type = "artifact"`. These are downloadable
 * file artifacts produced by an agent while working on an issue.
 *
 * Computed server-side; no new persistence.
 */

export interface DeliverableIssueRef {
  /** Issue UUID */
  id: string;
  /** Human-readable identifier such as "PAP-42" (may be null for legacy rows) */
  identifier: string | null;
  title: string;
  status: string;
}

export interface DeliverableAgentRef {
  id: string;
  name: string;
  /** Optional avatar/icon URL or initials key. Mirrors `agents.icon`. */
  icon: string | null;
}

export interface DeliverableListItem {
  /** issue_work_products.id */
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;

  /** URL to download the artifact (already auth-scoped). */
  contentPath: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;

  /** The issue the agent actually worked on when producing the artifact. */
  childIssue: DeliverableIssueRef;
  /**
   * The topmost ancestor in the issue's parent chain. `null` when `childIssue`
   * itself has no parent (i.e. it is the root).
   */
  rootIssue: DeliverableIssueRef | null;
  /** The agent that generated the artifact (resolved via createdByRunId). */
  agent: DeliverableAgentRef | null;
  runId: string | null;
}

export interface DeliverableDetail extends DeliverableListItem {
  /**
   * Full ancestor chain from the immediate parent of `childIssue` up to the
   * root. Empty when the child issue has no parent. Order: nearest parent
   * first, root last.
   */
  ancestors: DeliverableIssueRef[];
}
