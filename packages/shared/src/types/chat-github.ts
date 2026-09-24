/** GitHub is a channel into an ordinary Paperclip task, not another executor. */
export const GITHUB_REVIEW_EVENTS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "mention",
  "comment",
] as const;
export type GitHubReviewEvent = (typeof GITHUB_REVIEW_EVENTS)[number];

export interface GitHubReviewPolicy {
  invocation: "mentions_only" | "linked_authors" | "allowed_authors";
  events: GitHubReviewEvent[];
  reviewDrafts: boolean;
  reviewBotAuthors: boolean;
  includeAuthors: string[];
  excludeAuthors: string[];
  targetBranches: string[];
  excludedBranches: string[];
  requiredLabels: string[];
  excludedLabels: string[];
  ignoredPaths: string[];
  instructions: string;
  prompts: Record<GitHubReviewEvent, string>;
  findingCategories: string[];
  minimumCommentSeverity: "info" | "warning" | "error";
  publishSummary: boolean;
  publishInline: boolean;
  allowApprove: boolean;
  allowRequestChanges: boolean;
  ratingThreshold: 1 | 2 | 3 | 4 | 5 | null;
}

export type GitHubAllowedPerson = {
  githubUserId: string;
  login: string;
  automaticReviews: boolean;
} & (
  | { kind: "member"; userId: string }
  | { kind: "guest"; sponsorUserId: string; permissionProfile: "restricted" }
);

export interface GitHubChatConfiguration {
  version: 1;
  /** Enabling the feature and bot tools is explicit for existing endpoints. */
  toolsEnabled: boolean;
  responsibleUserId: string;
  memberAccess: "all_linked" | "selected";
  people: GitHubAllowedPerson[];
  defaults: GitHubReviewPolicy;
  /** Keys are stable GitHub repository IDs; labels never grant access. */
  repositories: Record<string, Partial<GitHubReviewPolicy>>;
}

export interface GitHubReviewEventContext {
  event: GitHubReviewEvent;
  deliveryId: string;
  repositoryId: string;
  repository: string;
  pullNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  author: { id: string; login: string; isBot: boolean };
  sender: { id: string; login: string };
  draft: boolean;
  labels: string[];
  previousHeadSha?: string;
  /** Latest assessed commit, which may precede several unreviewed pushes. */
  priorReviewedHeadSha?: string;
}

export interface GitHubReviewFinding {
  /** Stable agent-supplied key; combined with path and line for deduplication. */
  key: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "info" | "warning" | "error";
  category: string;
  body: string;
}

export interface GitHubReviewAssessment {
  reviewedCommit: string;
  score: 0 | 1 | 2 | 3 | 4 | 5;
  complete: boolean;
  summary: string;
  rationale: string;
  coverage: {
    reviewedPaths: string[];
    omittedPaths: string[];
    limitations: string[];
  };
  findings: GitHubReviewFinding[];
}

export type GitHubReviewConclusion =
  "success" | "failure" | "neutral" | "action_required";

/** Stored evidence attached to a task/run. Never independently scheduled. */
export interface GitHubTaskReview {
  id: string;
  companyId: string;
  endpointId: string;
  issueId: string;
  runId: string | null;
  repositoryId: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  configurationRevision: number;
  event: GitHubReviewEventContext;
  state:
    | "queued"
    | "running"
    | "completed"
    | "incomplete"
    | "error"
    | "superseded"
    | "manual_required";
  assessment: GitHubReviewAssessment | null;
  conclusion: GitHubReviewConclusion | null;
  checkUrl: string | null;
  summaryUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export const GITHUB_REVIEW_RUBRIC = [
  "0: No usable assessment; analysis is incomplete or cannot establish coverage.",
  "1: Critical defects make the change unsafe to ship.",
  "2: Major defects require substantial correction.",
  "3: Meaningful defects require correction before merging.",
  "4: Minor concerns remain; explain their impact and remaining risk.",
  "5: No actionable defects found within the stated coverage and limitations.",
] as const;

export const DEFAULT_GITHUB_REVIEW_PROMPTS: Record<GitHubReviewEvent, string> =
  {
    opened:
      "Review this new pull request. Inspect the diff and relevant context, assess correctness and security, and submit a structured assessment with the reviewed commit, rationale, and coverage.",
    synchronize:
      "Review the updated commits and changes since the prior assessment. Recheck prior findings and submit a new assessment for the current head.",
    reopened:
      "This pull request was reopened. Review its current head and prior discussion and submit an updated assessment.",
    ready_for_review:
      "This pull request is ready for review. Inspect its current head and submit a structured assessment.",
    mention:
      "Respond to the authorized person's request in this GitHub conversation. If they request a review, assess the current head using the review tools.",
    comment:
      "Continue the existing Paperclip task with this GitHub reply. Ordinary discussion does not change the review rating.",
  };

export function defaultGitHubReviewPolicy(): GitHubReviewPolicy {
  return {
    invocation: "linked_authors",
    events: [...GITHUB_REVIEW_EVENTS],
    reviewDrafts: false,
    reviewBotAuthors: false,
    includeAuthors: [],
    excludeAuthors: [],
    targetBranches: [],
    excludedBranches: [],
    requiredLabels: [],
    excludedLabels: [],
    ignoredPaths: [],
    instructions: "",
    prompts: { ...DEFAULT_GITHUB_REVIEW_PROMPTS },
    findingCategories: [
      "correctness",
      "security",
      "reliability",
      "maintainability",
    ],
    minimumCommentSeverity: "warning",
    publishSummary: true,
    publishInline: true,
    allowApprove: false,
    allowRequestChanges: false,
    ratingThreshold: 5,
  };
}
