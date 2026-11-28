import { z } from "zod";

/**
 * Agent-written status for a responsibility (experimental,
 * `enableResponsibilities`). Besides the status the server derives from the
 * number, a responsibility can carry a status that an agent wrote: behind, at
 * risk or on track (or that it cannot tell yet), one plain line saying why,
 * optionally a little detail, who wrote it and when. Each report is kept; the
 * newest is current. A person may correct it; the record then says a person
 * wrote it.
 *
 * The rules live here, pure, so the server, the agent's prompt and the views
 * agree on them: who the reporter is, what a report may say, and when it is
 * out of date.
 */

// ---------------------------------------------------------------------------
// What a report says
// ---------------------------------------------------------------------------

/** `unknown`: the agent looked and cannot tell yet. */
export const RESPONSIBILITY_STATUS_REPORT_STATUSES = ["behind", "at_risk", "on_track", "unknown"] as const;
export type ResponsibilityStatusReportStatus = (typeof RESPONSIBILITY_STATUS_REPORT_STATUSES)[number];

export const RESPONSIBILITY_STATUS_REPORT_LABEL: Record<ResponsibilityStatusReportStatus, string> = {
  behind: "Behind",
  at_risk: "At risk",
  on_track: "On track",
  unknown: "Can't tell yet",
};

/** A report older than this many days reads as out of date (it is still shown). */
export const RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS = 7;
/** Past reports one read returns, newest first. */
export const RESPONSIBILITY_STATUS_REPORT_HISTORY_LIMIT = 10;
export const RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX = 200;
export const RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX = 800;

const DAY_MS = 86_400_000;

const MARKUP = /(^#{1,6}\s)|(\*\*)|(\[[^\]]*\]\([^)]*\))|(`)/;

function statusWordsOnly(text: string) {
  const plain = text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return ["behind", "at risk", "on track", "unknown", "cant tell yet", "ok", "fine", "good", "bad"].includes(plain);
}

/**
 * The body of a report, whoever writes it. The author is never in the body:
 * the server records the agent or person who sent it.
 */
export const writeResponsibilityStatusReportSchema = z
  .object({
    status: z.enum(RESPONSIBILITY_STATUS_REPORT_STATUSES),
    /** One plain line saying why: "Drifted from 2.1 s to 2.4 s as the catalogue grew." */
    message: z.string().trim().min(3).max(RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX),
    /** Optional: a couple more sentences of detail. */
    detail: z.string().trim().min(1).max(RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (/[\r\n]/.test(value.message)) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "Keep the message to one line; put anything more in detail" });
    }
    if (MARKUP.test(value.message)) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "Write the message as plain words, without markdown" });
    }
    if (statusWordsOnly(value.message)) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "Say why, not only the status: what moved, and what it depends on" });
    }
    if (value.detail && value.detail.split(/\r?\n/).filter((line) => line.trim()).length > 4) {
      ctx.addIssue({ code: "custom", path: ["detail"], message: "Keep the detail to a few sentences" });
    }
  });
export type WriteResponsibilityStatusReport = z.infer<typeof writeResponsibilityStatusReportSchema>;

/** The owner asks the reporter for an update. Nothing to send: the server picks the reporter. */
export const requestResponsibilityStatusUpdateSchema = z.object({}).strict();
export type RequestResponsibilityStatusUpdate = z.infer<typeof requestResponsibilityStatusUpdateSchema>;

// ---------------------------------------------------------------------------
// What the reads return
// ---------------------------------------------------------------------------

/** One report. Exactly one of `agentId` and `userId` is set, or neither once the agent is deleted. */
export interface ResponsibilityStatusReportEntry {
  status: ResponsibilityStatusReportStatus;
  message: string;
  agentId: string | null;
  userId: string | null;
  /** ISO time it was written. */
  writtenAt: string;
}

export interface ResponsibilityStatusReportCurrent extends ResponsibilityStatusReportEntry {
  detail: string | null;
  /** Older than `RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS`. */
  outOfDate: boolean;
}

/**
 * `GET /api/responsibilities/:id/status-report` and
 * `POST /api/responsibilities/:id/status-report/request`.
 */
export interface ResponsibilityStatusReportState {
  current: ResponsibilityStatusReportCurrent | null;
  /** The agent with the best total view of it (see `chooseResponsibilityReporter`); null when the company has no agent that can take work. */
  reporterAgentId: string | null;
  /** The owner asked the reporter for an update and no report has come since. */
  updateRequested: boolean;
  /** Newest first, at most `RESPONSIBILITY_STATUS_REPORT_HISTORY_LIMIT`, the current one included. */
  history: ResponsibilityStatusReportEntry[];
}

/** Why the reporter is who it is. */
export type ResponsibilityReporterBasis = "works_under" | "top_agent" | "first_agent";

export interface ResponsibilityStatusReportSummary {
  responsibilityId: string;
  current: ResponsibilityStatusReportCurrent | null;
  reporterAgentId: string | null;
  reporterBasis: ResponsibilityReporterBasis | null;
  updateRequested: boolean;
}

/** `GET /api/companies/:companyId/responsibilities/status-reports`: every active responsibility of the owner, in one read. */
export interface ResponsibilityStatusReportsOverview {
  ownerUserId: string;
  freshDays: number;
  reports: ResponsibilityStatusReportSummary[];
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** True when the report is older than `days` (default `RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS`). */
export function responsibilityStatusReportOutOfDate(
  writtenAt: Date | string,
  now: Date,
  days: number = RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS,
): boolean {
  return now.getTime() - new Date(writtenAt).getTime() > days * DAY_MS;
}

// ---------------------------------------------------------------------------
// The reporter rule
// ---------------------------------------------------------------------------

/** One agent's work under a responsibility: directly, or through a linked project. */
export interface ResponsibilityReporterCandidate {
  agentId: string;
  /** Open tasks under it assigned to the agent. */
  openTasks: number;
  /** Routines under it (not archived) assigned to the agent. */
  routines: number;
  /** Unfinished linked projects the agent leads. */
  ledProjects: number;
  /** The agent runs the responsibility (`runByAgentId`). */
  runsIt: boolean;
  /** The latest update of any of that work. */
  lastActivityAt: Date | string | null;
}

export interface ResponsibilityReporterAgent {
  id: string;
  role: string | null;
  reportsTo: string | null;
  createdAt: Date | string;
  /** Assignable and not paused, terminated or awaiting approval. */
  canTakeWork: boolean;
}

/** How much an agent does under a responsibility: each open task, routine and led project counts one; running it counts one more. */
export function responsibilityReporterScore(candidate: Omit<ResponsibilityReporterCandidate, "agentId" | "lastActivityAt">): number {
  return Math.max(0, candidate.openTasks) + Math.max(0, candidate.routines) + Math.max(0, candidate.ledProjects) + (candidate.runsIt ? 1 : 0);
}

function time(value: Date | string | null) {
  return value === null ? Number.NEGATIVE_INFINITY : new Date(value).getTime();
}

/**
 * The agent with the best total view of a responsibility, who writes its
 * status:
 * 1. Of the agents that can take work, the one doing the most under it
 *    (`responsibilityReporterScore`), ties broken by the most recent activity
 *    there, then by running it, then by who was created first.
 * 2. When no such agent works under it: the organization's top agent (a CEO
 *    reporting to nobody, else the first-created agent reporting to nobody).
 * 3. Else the first-created agent that can take work. Null when there is none.
 */
export function chooseResponsibilityReporter(
  candidates: readonly ResponsibilityReporterCandidate[],
  agents: readonly ResponsibilityReporterAgent[],
): { agentId: string; basis: ResponsibilityReporterBasis } | null {
  const usable = [...agents]
    .filter((agent) => agent.canTakeWork)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  if (usable.length === 0) return null;
  const order = new Map(usable.map((agent, index) => [agent.id, index]));
  const working = candidates
    .filter((candidate) => order.has(candidate.agentId) && responsibilityReporterScore(candidate) > 0)
    .sort((a, b) =>
      responsibilityReporterScore(b) - responsibilityReporterScore(a)
      || time(b.lastActivityAt) - time(a.lastActivityAt)
      || Number(b.runsIt) - Number(a.runsIt)
      || order.get(a.agentId)! - order.get(b.agentId)!);
  if (working[0]) return { agentId: working[0].agentId, basis: "works_under" };
  const top = usable.find((agent) => agent.role === "ceo" && !agent.reportsTo) ?? usable.find((agent) => !agent.reportsTo);
  if (top) return { agentId: top.id, basis: "top_agent" };
  return { agentId: usable[0]!.id, basis: "first_agent" };
}
