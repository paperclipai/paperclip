import type { CompanyArtifact } from "./artifact.js";
import type { ResponsibilityMetricKind } from "../responsibility-bars.js";
import type {
  IssueStatus,
  ProjectStatus,
  ResponsibilityAreaSource,
  ResponsibilityAreaStatus,
  ResponsibilityHealth,
  ResponsibilityHealthOverride,
  ResponsibilityMetricDirection,
  ResponsibilitySource,
  ResponsibilityStatus,
  ResponsibilityWorkSignalKind,
  ResponsibilityWorkSignalTone,
  RoutineStatus,
} from "../constants.js";

/**
 * A broad area a company cares about ("Fundraising"). No owner, no deadline.
 * Responsibilities are filed under an area (experimental, `enableResponsibilities`).
 */
export interface ResponsibilityArea {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: ResponsibilityAreaStatus;
  source: ResponsibilityAreaSource;
  proposedByAgentId: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The area a responsibility sits under, as the detail returns it. */
export interface ResponsibilityAreaRef {
  id: string;
  title: string;
  status: ResponsibilityAreaStatus;
}

/**
 * Something one person owns in a company, always ongoing. Its bar is the
 * sentence in `standard` plus a metric with a target; status comes from the
 * metric (experimental, `enableResponsibilities`).
 */
export interface Responsibility {
  id: string;
  companyId: string;
  /** Auth user id of the person who owns it. Always a person. */
  ownerUserId: string;
  /** The area it is filed under, or null. */
  areaId: string | null;
  title: string;
  description: string | null;
  /** The bar, as a sentence: how success is measured. Required before it can be active. */
  standard: string | null;
  /**
   * The bar template: `volume`, `percentage`, `yes_no` or `range` (see
   * `RESPONSIBILITY_BAR_TEMPLATES`). Rows saved before templates existed read
   * as `percentage` when their unit is "%", otherwise as `volume`.
   */
  metricKind: ResponsibilityMetricKind;
  /** What is measured, e.g. "Investors contacted"; for `yes_no`, the statement that should be true. Required before it can be active. */
  metricName: string | null;
  /** Unit for the values: a symbol ("%", "$") or a word ("days"). Always "%" for `percentage`; null for `yes_no`. */
  metricUnit: string | null;
  /** Volume and percentage: the number to reach (or stay under, for `at_most`). Required for them before it can be active. */
  metricTarget: number | null;
  /** Range: the lowest value that is still inside. Required for a range before it can be active. */
  metricLow: number | null;
  /** Range: the highest value that is still inside. Required for a range before it can be active. */
  metricHigh: number | null;
  /** The latest reading; for `yes_no`, 1 is yes and 0 is no. Null until someone reports one. */
  metricCurrent: number | null;
  /** Volume and percentage only (null for the other templates); null on rows created before metrics existed, treated as `at_least`. */
  metricDirection: ResponsibilityMetricDirection | null;
  /** When `metricCurrent` last changed. */
  metricUpdatedAt: Date | null;
  /** The agent that runs the work and keeps the metric current, if any. */
  runByAgentId: string | null;
  status: ResponsibilityStatus;
  source: ResponsibilitySource;
  /** Why an agent proposed it. Shown to the owner while it is proposed. */
  evidence: string | null;
  healthOverride: ResponsibilityHealthOverride | null;
  healthNote: string | null;
  sortOrder: number;
  proposedByAgentId: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One project, task or routine filed under a responsibility. Exactly one target id is set. */
export interface ResponsibilityLink {
  id: string;
  companyId: string;
  responsibilityId: string;
  projectId: string | null;
  issueId: string | null;
  routineId: string | null;
  createdAt: Date;
}

/** A member project whose target date has passed while it is unfinished. */
export interface ResponsibilityOverdueProject {
  id: string;
  name: string;
  /** `YYYY-MM-DD`. */
  targetDate: string;
  daysOverdue: number;
}

/** The metric with its derived attainment; null on the rollup when no metric name is set. */
export interface ResponsibilityMetricSummary {
  kind: ResponsibilityMetricKind;
  name: string;
  /** Always "%" for `percentage`; null for `yes_no`. */
  unit: string | null;
  /** Volume and percentage only. */
  target: number | null;
  /** Range only. */
  low: number | null;
  high: number | null;
  /** For `yes_no`, 1 is yes and 0 is no. */
  current: number | null;
  /** Volume and percentage: `at_least` unless set to `at_most`. Null for the other templates. */
  direction: ResponsibilityMetricDirection | null;
  /**
   * How far the reading is toward the bar (1 = met), rounded to 4 places.
   * Volume and percentage: `at_least` is current / target when target > 0,
   * floored at 0; `at_most` is target / current when both are > 0; any other
   * case (target <= 0, or an `at_most` reading <= 0) is pass/fail, 1 when met
   * and 0 when not. Yes or no: 1 for yes, 0 for no. Range: 1 inside the
   * bounds, otherwise 1 - distance outside / width, floored at 0. Null when
   * the bar is incomplete or there is no reading.
   */
  attainment: number | null;
  /** One line on how status is read ("On track at 90% or more; at risk from 68%"); null when the bar is incomplete. */
  statusRule: string | null;
  updatedAt: Date | null;
  /** True when there is a reading and it is older than `RESPONSIBILITY_METRIC_STALE_DAYS`. */
  stale: boolean;
}

export type ResponsibilityWorkSignalRefType = "project" | "issue" | "routine" | "agent" | "user" | "responsibility";

/** One line bubbled up from the work under a responsibility. */
export interface ResponsibilityWorkSignal {
  kind: ResponsibilityWorkSignalKind;
  tone: ResponsibilityWorkSignalTone;
  /** Display text, a complete short sentence fragment without a trailing period. */
  text: string;
  /** What the signal refers to; null for an aggregate line (and for a "more" line). */
  refType: ResponsibilityWorkSignalRefType | null;
  refId: string | null;
  /** How many items the line covers (1 for a single project, task or routine). */
  count: number;
}

export interface ResponsibilityRollup {
  /** Effective status: the override when set, otherwise `computedHealth`. */
  health: ResponsibilityHealth;
  /** Status from the metric alone, ignoring any override. Work does not change it. */
  computedHealth: ResponsibilityHealth;
  /** True when `healthOverride` is set; the owner's reason is `healthNote` on the responsibility. */
  healthOverridden: boolean;
  metric: ResponsibilityMetricSummary | null;
  /**
   * A short deterministic sentence from the metric numbers (never the
   * override): "12 of 20 investors contacted, 60% of target", "Reply time is
   * 3 days against a target of 2 days", or a "Not measured…" sentence.
   */
  statusSentence: string;
  /**
   * Signals from the projects, tasks and routines underneath, ordered by tone
   * (attention, neutral, good) then by `RESPONSIBILITY_WORK_SIGNAL_KINDS`.
   * Also carries a `metric_stale` line when the reading is stale.
   */
  workSummary: ResponsibilityWorkSignal[];
  /** Member projects (any status). */
  projects: number;
  /** Member routines that are not archived. */
  routines: number;
  openTasks: number;
  blockedTasks: number;
  /** Open tasks assigned to an agent. */
  agentTasks: number;
  /** Open tasks assigned to a person, or unassigned. */
  userTasks: number;
  doneTasks: number;
  /** Earliest target date (`YYYY-MM-DD`) of a member project that is not completed or cancelled. */
  nextDueAt: string | null;
  overdueProjects: ResponsibilityOverdueProject[];
}

export interface ResponsibilityWithRollup extends Responsibility {
  rollup: ResponsibilityRollup;
}

export interface ResponsibilityProjectSummary {
  linkId: string;
  id: string;
  name: string;
  status: ProjectStatus;
  targetDate: string | null;
  leadAgentId: string | null;
  archivedAt: Date | null;
  /**
   * Its tasks the reader can see: how many are done, of those not
   * cancelled. Null when it has none.
   */
  progress: ResponsibilityProjectProgress | null;
}

export interface ResponsibilityProjectProgress {
  done: number;
  /** Tasks in the project that are not cancelled; always more than zero. */
  total: number;
}

/** How a task or routine is under a responsibility: linked itself, or through a linked project. */
export type ResponsibilityTaskMembership = "direct" | "project";

export interface ResponsibilityTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  membership: ResponsibilityTaskMembership;
  /** The direct link id; null when the task is under it only through its project. */
  linkId: string | null;
  updatedAt: Date;
}

export interface ResponsibilityRoutineSummary {
  /** The direct link id; null when the routine is under it only through its project. */
  linkId: string | null;
  membership: ResponsibilityTaskMembership;
  id: string;
  title: string;
  status: RoutineStatus;
  assigneeAgentId: string | null;
  projectId: string | null;
  /** How its latest run went, from the routines module; null when it has not run. */
  lastRun: ResponsibilityRoutineLastRun | null;
}

/**
 * A routine's latest run that ran (skipped and merged runs never did):
 * `succeeded` (its task was finished), `failed`, or `running` (its task is
 * made and not finished). `at` is when it ended, or when it started while
 * running.
 */
export interface ResponsibilityRoutineLastRun {
  outcome: "succeeded" | "failed" | "running";
  at: Date;
}

/**
 * A company skill held by an agent that works under a responsibility: its
 * `runByAgentId`, the assignees of its open member tasks and of its
 * non-archived routines, and its linked projects' lead agents. Paperclip's
 * own coordination and onboarding skills are left out.
 */
export interface ResponsibilitySkillSummary {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  tagline: string | null;
  iconUrl: string | null;
  color: string | null;
  /** Which of those agents hold it, sorted. */
  agentIds: string[];
}

export interface ResponsibilityDetail extends ResponsibilityWithRollup {
  area: ResponsibilityAreaRef | null;
  /** By name. */
  skills: ResponsibilitySkillSummary[];
  /**
   * Artifacts from member tasks (direct and through linked projects), as the
   * company artifacts list shows them, newest first. At most
   * `RESPONSIBILITY_DETAIL_ARTIFACT_LIMIT`.
   */
  artifacts: CompanyArtifact[];
  /** All member-task artifacts, counted up to `RESPONSIBILITY_ARTIFACT_COUNT_LIMIT`. */
  artifactsTotal: number;
  /** True when `artifactsTotal` is more than `artifacts` lists. */
  artifactsTruncated: boolean;
  projects: ResponsibilityProjectSummary[];
  /** Open tasks first, then most recently updated. At most `RESPONSIBILITY_DETAIL_TASK_LIMIT`. */
  tasks: ResponsibilityTaskSummary[];
  /** True when more member tasks exist than `tasks` lists. Counts in `rollup` are always complete. */
  tasksTruncated: boolean;
  /** Linked routines and routines in a linked project, archived ones included. */
  routines: ResponsibilityRoutineSummary[];
}

export interface ResponsibilityOverviewTotals {
  /** Active responsibilities by effective status. */
  byHealth: Record<ResponsibilityHealth, number>;
  /** Distinct open tasks under any active responsibility (a task under two counts once). */
  openTasks: number;
  agentTasks: number;
  userTasks: number;
  /** Distinct member tasks whose status is blocked. */
  blockedTasks: number;
  /** Distinct unfinished projects linked under any active responsibility. */
  projects: number;
  /** Of `projects`, those past their target date. */
  lateProjects: number;
}

/** An area in the overview, with this owner's active responsibilities under it by status. */
export interface ResponsibilityOverviewArea extends ResponsibilityArea {
  activeResponsibilities: number;
  byHealth: Record<ResponsibilityHealth, number>;
}

export type ResponsibilityLooseProject = Omit<ResponsibilityProjectSummary, "linkId" | "progress">;
export type ResponsibilityLooseTask = Omit<ResponsibilityTaskSummary, "membership" | "linkId">;
export type ResponsibilityLooseRoutine = Omit<ResponsibilityRoutineSummary, "membership" | "linkId" | "lastRun">;

/**
 * Company-wide work under no responsibility, directly or through a project:
 * unfinished projects, open tasks and active routines. Lists are capped; the
 * counts are complete.
 */
export interface ResponsibilityLooseWork {
  projectCount: number;
  openTaskCount: number;
  routineCount: number;
  /** By target date (none last), then name. At most `RESPONSIBILITY_LOOSE_LIST_LIMIT`. */
  projects: ResponsibilityLooseProject[];
  /** Most recently updated first. At most `RESPONSIBILITY_LOOSE_TASK_LIMIT`. */
  tasks: ResponsibilityLooseTask[];
  /** By title. At most `RESPONSIBILITY_LOOSE_LIST_LIMIT`. */
  routines: ResponsibilityLooseRoutine[];
}

export interface ResponsibilityOverview {
  ownerUserId: string;
  /**
   * Every active area in the company, plus any other area (proposed or
   * archived) that a returned responsibility is filed under. By sortOrder,
   * then title.
   */
  areas: ResponsibilityOverviewArea[];
  /** Active responsibilities (plus `let_go` ones when `includeLetGo=true`), by sortOrder then createdAt. */
  responsibilities: ResponsibilityWithRollup[];
  /** Responsibilities an agent or the owner proposed that are not yet confirmed. */
  proposed: ResponsibilityWithRollup[];
  /** Totals over active responsibilities only. */
  totals: ResponsibilityOverviewTotals;
  loose: ResponsibilityLooseWork;
}

export interface ResponsibilityDelegationResult {
  /** The created task, as the issue service returns it. */
  issue: {
    id: string;
    companyId: string;
    identifier: string | null;
    title: string;
    status: IssueStatus;
    assigneeAgentId: string | null;
    projectId: string | null;
  } & Record<string, unknown>;
  link: ResponsibilityLink;
}

/** One responsibility a project, task or routine is under. */
export interface ResponsibilityLinkLookupEntry {
  id: string;
  title: string;
  areaId: string | null;
  ownerUserId: string;
  via: "direct" | "project";
}

/** `GET /api/companies/:companyId/responsibility-links/lookup`. Empty when the item is loose. */
export interface ResponsibilityLinkLookupResult {
  responsibilities: ResponsibilityLinkLookupEntry[];
}

/** Who wrote a responsibility summary paragraph: a model, or Paperclip from the same facts. */
export type ResponsibilitySummarySource = "model" | "computed";

/**
 * A short plain-prose paragraph written to the owner.
 * `GET /api/companies/:companyId/responsibilities/summary` ("Where things
 * stand", across the owner's active responsibilities) and
 * `GET /api/responsibilities/:id/summary` ("What is affecting the number").
 * Never empty: when no model text fits the current facts, `text` is composed
 * from them by Paperclip.
 */
export interface ResponsibilitySummary {
  text: string;
  source: ResponsibilitySummarySource;
  /** ISO time the text was written (for computed text, the time of this response). */
  generatedAt: string;
  /** True when newer model text is on its way: ask again shortly to get it. */
  refreshing: boolean;
}
