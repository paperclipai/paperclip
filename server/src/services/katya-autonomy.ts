export type KatyaLane = string;
export type KatyaContentType = string;

export interface KatyaDueWindow {
  startAt: string | null;
  endAt: string | null;
  timezone?: string | null;
}

export interface KatyaWeeklyCounter {
  target: number;
  completed: number;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface KatyaOwner {
  agentId?: string | null;
  userId?: string | null;
  displayName?: string | null;
}

export interface KatyaProofMetadata {
  urlOrPostId?: string | null;
  timestamp?: string | null;
  platformChannel?: string | null;
}

export interface KatyaOutreachQuotas {
  thursday: number | null;
  friday: number | null;
}

export interface KatyaOutreachHardening {
  quotas: KatyaOutreachQuotas | null;
  prospectMatchPath: string[];
  approvalQueueStatus?: string | null;
}

export interface KatyaOutreachHardeningEvaluation {
  complete: boolean;
  missing: string[];
  discipline: {
    quotasConfigured: boolean;
    prospectPathConfigured: boolean;
    approvalQueueDisciplined: boolean;
  };
}

export interface KatyaBlockerEscalationMetadata {
  owner: KatyaOwner | null;
  dueAt: string | null;
  terminalState: string | null;
  notes?: string | null;
}

export interface KatyaSelfManagementScoreboard {
  total: number;
  due: number;
  overdue: number;
  scheduled: number;
  unscheduled: number;
  weeklyMet: number;
  weeklyBehind: number;
  weeklyMissed: number;
  weeklyNotConfigured: number;
}

export interface KatyaBehindScheduleState {
  behind: boolean;
  reasons: string[];
  overdueCount: number;
  weeklyBehindCount: number;
  weeklyMissedCount: number;
}

export interface KatyaCheckWindowEvaluation {
  checkWindow: string | null;
  isScheduledCheck: boolean;
  behindSchedule: boolean;
  shouldEscalate: boolean;
  reasons: string[];
}

export interface KatyaMetadataTemplate {
  lane: KatyaLane | null;
  contentType: KatyaContentType | null;
  dependencies: string[];
  dueWindow: KatyaDueWindow;
  owner: KatyaOwner | null;
  proof: KatyaProofMetadata | null;
  weeklyCounter?: KatyaWeeklyCounter | null;
  outreachHardening?: KatyaOutreachHardening | null;
}

export type KatyaDueState =
  | "unscheduled"
  | "scheduled"
  | "due"
  | "overdue";

export type KatyaWeeklyState =
  | "not_configured"
  | "met"
  | "behind"
  | "missed";

export interface KatyaDueStateSummary {
  dueState: KatyaDueState;
  weeklyState: KatyaWeeklyState;
  dueWindow: KatyaDueWindow;
  weeklyCounter: KatyaWeeklyCounter | null;
}

export function buildKatyaMetadataTemplate(): KatyaMetadataTemplate {
  return {
    lane: null,
    contentType: null,
    dependencies: [],
    dueWindow: {
      startAt: null,
      endAt: null,
      timezone: null,
    },
    owner: null,
    proof: null,
    weeklyCounter: null,
    outreachHardening: buildKatyaOutreachHardeningTemplate(),
  };
}

export function buildKatyaOutreachHardeningTemplate(): KatyaOutreachHardening {
  return {
    quotas: {
      thursday: null,
      friday: null,
    },
    prospectMatchPath: [],
    approvalQueueStatus: null,
  };
}

export function evaluateKatyaOutreachHardening(input: KatyaOutreachHardening | null | undefined): KatyaOutreachHardeningEvaluation {
  const missing: string[] = [];
  const quotas = input?.quotas ?? null;
  const hasThursday = typeof quotas?.thursday === "number" && Number.isFinite(quotas.thursday) && quotas.thursday > 0;
  const hasFriday = typeof quotas?.friday === "number" && Number.isFinite(quotas.friday) && quotas.friday > 0;
  if (!hasThursday) missing.push("thursday quota");
  if (!hasFriday) missing.push("friday quota");

  const prospectMatchPath = (input?.prospectMatchPath ?? []).filter((step) => step.trim());
  if (prospectMatchPath.length === 0) missing.push("prospect match path");

  const approvalQueueStatus = typeof input?.approvalQueueStatus === "string"
    ? input.approvalQueueStatus.trim()
    : "";
  if (!approvalQueueStatus) missing.push("approval queue status");

  const normalizedQueueStatus = approvalQueueStatus.toLowerCase();
  const queueDisciplined = normalizedQueueStatus.length > 0
    && !["unknown", "tbd", "none", "n/a", "na"].includes(normalizedQueueStatus);
  if (!queueDisciplined) missing.push("approval queue discipline");

  return {
    complete: missing.length === 0,
    missing,
    discipline: {
      quotasConfigured: hasThursday && hasFriday,
      prospectPathConfigured: prospectMatchPath.length > 0,
      approvalQueueDisciplined: queueDisciplined,
    },
  };
}

export function normalizeKatyaMetadata(input: unknown): KatyaMetadataTemplate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const template = buildKatyaMetadataTemplate();

  if (typeof record.lane === "string") template.lane = record.lane;
  if (typeof record.contentType === "string") template.contentType = record.contentType;

  if (Array.isArray(record.dependencies)) {
    template.dependencies = record.dependencies
      .map((dep) => String(dep).trim())
      .filter(Boolean);
  }

  const dueWindow = record.dueWindow && typeof record.dueWindow === "object"
    ? record.dueWindow as Record<string, unknown>
    : null;
  if (dueWindow) {
    template.dueWindow = {
      startAt: typeof dueWindow.startAt === "string" ? dueWindow.startAt : null,
      endAt: typeof dueWindow.endAt === "string" ? dueWindow.endAt : null,
      timezone: typeof dueWindow.timezone === "string" ? dueWindow.timezone : null,
    };
  }

  if (record.owner && typeof record.owner === "object") {
    const owner = record.owner as Record<string, unknown>;
    template.owner = {
      agentId: typeof owner.agentId === "string" ? owner.agentId : null,
      userId: typeof owner.userId === "string" ? owner.userId : null,
      displayName: typeof owner.displayName === "string" ? owner.displayName : null,
    };
  }

  if (record.proof && typeof record.proof === "object") {
    const proof = record.proof as Record<string, unknown>;
    template.proof = {
      urlOrPostId: typeof proof.urlOrPostId === "string" ? proof.urlOrPostId : null,
      timestamp: typeof proof.timestamp === "string" ? proof.timestamp : null,
      platformChannel: typeof proof.platformChannel === "string" ? proof.platformChannel : null,
    };
  }

  if (record.weeklyCounter && typeof record.weeklyCounter === "object") {
    const weeklyCounter = record.weeklyCounter as Record<string, unknown>;
    const target = typeof weeklyCounter.target === "number" ? weeklyCounter.target : null;
    const completed = typeof weeklyCounter.completed === "number" ? weeklyCounter.completed : null;
    const weekStartsOnRaw = weeklyCounter.weekStartsOn;
    const weekStartsOn =
      typeof weekStartsOnRaw === "number" && Number.isInteger(weekStartsOnRaw)
        ? (weekStartsOnRaw as 0 | 1 | 2 | 3 | 4 | 5 | 6)
        : null;
    if (target !== null || completed !== null || weekStartsOn !== null) {
      template.weeklyCounter = {
        target: target ?? 0,
        completed: completed ?? 0,
        ...(weekStartsOn !== null ? { weekStartsOn } : {}),
      };
    }
  }

  if (record.outreachHardening && typeof record.outreachHardening === "object") {
    const outreach = record.outreachHardening as Record<string, unknown>;
    const quotas = outreach.quotas && typeof outreach.quotas === "object"
      ? outreach.quotas as Record<string, unknown>
      : null;
    template.outreachHardening = {
      quotas: {
        thursday: typeof quotas?.thursday === "number" ? quotas?.thursday : null,
        friday: typeof quotas?.friday === "number" ? quotas?.friday : null,
      },
      prospectMatchPath: Array.isArray(outreach.prospectMatchPath)
        ? outreach.prospectMatchPath.map((step) => String(step).trim()).filter(Boolean)
        : [],
      approvalQueueStatus: typeof outreach.approvalQueueStatus === "string"
        ? outreach.approvalQueueStatus
        : null,
    };
  }

  return template;
}

export function buildKatyaBlockerEscalationTemplate(): KatyaBlockerEscalationMetadata {
  return {
    owner: null,
    dueAt: null,
    terminalState: null,
    notes: null,
  };
}

export function isBlockerEscalationComplete(input: KatyaBlockerEscalationMetadata | null | undefined) {
  if (!input) return false;
  const owner = input.owner ?? null;
  const hasOwner = Boolean(owner && (owner.agentId || owner.userId || owner.displayName));
  const hasDue = Boolean(typeof input.dueAt === "string" && input.dueAt.trim());
  const terminal = typeof input.terminalState === "string" ? input.terminalState.trim().toUpperCase() : "";
  const hasTerminal = ["DONE", "BLOCKED_WITH_NEW_TIME", "NEEDS_REVIEW"].includes(terminal);
  return hasOwner && hasDue && hasTerminal;
}

export function packageBlockerEscalationForPaperclip(input: KatyaBlockerEscalationMetadata | null | undefined) {
  const owner = input?.owner ?? null;
  const terminal = typeof input?.terminalState === "string" ? input.terminalState.trim().toUpperCase() : null;
  const dueAt = typeof input?.dueAt === "string" ? input.dueAt.trim() : "";
  const notes = typeof input?.notes === "string" ? input.notes.trim() : null;

  return {
    owner: owner && (owner.agentId || owner.userId || owner.displayName) ? owner : null,
    dueAt: dueAt || null,
    terminalState: terminal || null,
    notes: notes || null,
    complete: isBlockerEscalationComplete({
      owner,
      dueAt: dueAt || null,
      terminalState: terminal,
      notes,
    }),
  };
}

export function computeKatyaSelfManagementScoreboard(
  summaries: KatyaDueStateSummary[],
): KatyaSelfManagementScoreboard {
  const scoreboard: KatyaSelfManagementScoreboard = {
    total: summaries.length,
    due: 0,
    overdue: 0,
    scheduled: 0,
    unscheduled: 0,
    weeklyMet: 0,
    weeklyBehind: 0,
    weeklyMissed: 0,
    weeklyNotConfigured: 0,
  };

  for (const summary of summaries) {
    if (summary.dueState === "due") scoreboard.due += 1;
    if (summary.dueState === "overdue") scoreboard.overdue += 1;
    if (summary.dueState === "scheduled") scoreboard.scheduled += 1;
    if (summary.dueState === "unscheduled") scoreboard.unscheduled += 1;

    if (summary.weeklyState === "met") scoreboard.weeklyMet += 1;
    if (summary.weeklyState === "behind") scoreboard.weeklyBehind += 1;
    if (summary.weeklyState === "missed") scoreboard.weeklyMissed += 1;
    if (summary.weeklyState === "not_configured") scoreboard.weeklyNotConfigured += 1;
  }

  return scoreboard;
}

export function detectKatyaBehindSchedule(
  scoreboard: KatyaSelfManagementScoreboard,
): KatyaBehindScheduleState {
  const reasons: string[] = [];
  if (scoreboard.overdue > 0) reasons.push("overdue items");
  if (scoreboard.weeklyBehind > 0) reasons.push("weekly targets behind");
  if (scoreboard.weeklyMissed > 0) reasons.push("weekly targets missed");

  return {
    behind: reasons.length > 0,
    reasons,
    overdueCount: scoreboard.overdue,
    weeklyBehindCount: scoreboard.weeklyBehind,
    weeklyMissedCount: scoreboard.weeklyMissed,
  };
}



export function evaluateKatyaCheckWindow(
  checkWindow: string | null | undefined,
  behindSchedule: KatyaBehindScheduleState,
): KatyaCheckWindowEvaluation {
  const normalized = typeof checkWindow === "string" ? checkWindow.trim() : "";
  const scheduledChecks = new Set(["10:00", "15:00"]);
  const isScheduledCheck = scheduledChecks.has(normalized);
  const reasons = behindSchedule.behind ? [...behindSchedule.reasons] : [];

  return {
    checkWindow: normalized || null,
    isScheduledCheck,
    behindSchedule: behindSchedule.behind,
    shouldEscalate: isScheduledCheck && behindSchedule.behind,
    reasons,
  };
}

export function computeKatyaDueState(input: {
  now: Date;
  dueWindow?: KatyaDueWindow | null;
  weeklyCounter?: KatyaWeeklyCounter | null;
}): KatyaDueStateSummary {
  const dueWindow = input.dueWindow ?? { startAt: null, endAt: null, timezone: null };
  const now = input.now;
  const start = dueWindow.startAt ? new Date(dueWindow.startAt) : null;
  const end = dueWindow.endAt ? new Date(dueWindow.endAt) : null;

  let dueState: KatyaDueState = "unscheduled";
  if (start && end) {
    if (now < start) {
      dueState = "scheduled";
    } else if (now > end) {
      dueState = "overdue";
    } else {
      dueState = "due";
    }
  } else if (start && !end) {
    dueState = now < start ? "scheduled" : "due";
  } else if (!start && end) {
    dueState = now > end ? "overdue" : "due";
  }

  const weeklyCounter = input.weeklyCounter ?? null;
  let weeklyState: KatyaWeeklyState = "not_configured";
  if (weeklyCounter) {
    const target = Math.max(0, weeklyCounter.target);
    const completed = Math.max(0, weeklyCounter.completed);
    const remaining = Math.max(0, target - completed);

    if (remaining === 0) {
      weeklyState = "met";
    } else {
      const weekStartsOn = weeklyCounter.weekStartsOn ?? 1;
      const weekStart = startOfWeek(now, weekStartsOn);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      weeklyState = now >= weekEnd ? "missed" : "behind";
    }
  }

  return {
    dueState,
    weeklyState,
    dueWindow,
    weeklyCounter,
  };
}

export type KatyaApprovalStatus =
  | "revision_requested"
  | "pending"
  | "approved"
  | "paused"
  | "scheduled"
  | "published"
  | "recalled"
  | "rejected"
  | "cancelled"
  | "draft";

const KATYA_APPROVAL_PRIORITY: Record<KatyaApprovalStatus, number> = {
  revision_requested: 0,
  pending: 1,
  approved: 2,
  paused: 3,
  scheduled: 4,
  published: 5,
  recalled: 6,
  rejected: 7,
  cancelled: 8,
  draft: 9,
};

export function compareKatyaApprovalStatus(a: KatyaApprovalStatus, b: KatyaApprovalStatus): number {
  return KATYA_APPROVAL_PRIORITY[a] - KATYA_APPROVAL_PRIORITY[b];
}

function startOfWeek(input: Date, weekStartsOn: number): Date {
  const date = new Date(input);
  const day = date.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
