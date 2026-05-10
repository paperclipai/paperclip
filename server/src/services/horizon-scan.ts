// Horizon Scan: anomaly detection for CEO's always-on monitoring (§2, VOG-5810)
// Pure functions — no API calls, testable without I/O.

export interface HorizonScanConfig {
  p0StallHours: number;
  p1StallHours: number;
  engineerStallL1Hours: number;
  engineerStallL2Hours: number;
  engineerReviewZombieHours: number;
  outstandingAskMinutes: number;
  boardWaitEscalateMinutes: number;
}

export const DEFAULT_CONFIG: HorizonScanConfig = {
  p0StallHours: 4.0,
  p1StallHours: 24.0,
  engineerStallL1Hours: 24.0,
  engineerStallL2Hours: 48.0,
  engineerReviewZombieHours: 72.0,
  outstandingAskMinutes: 30,
  boardWaitEscalateMinutes: 60,
};

// ────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────

export type AnomalyType =
  | "P0_STALLED"
  | "P1_STALLED"
  | "BLOCKER_CHAIN"
  | "REVIEW_STALLED"
  | "BOARD_WAIT_LONG"
  | "ENGINEER_ISSUE_STALLED_24H"
  | "ENGINEER_ALL_STALLED_48H"
  | "REVIEW_ZOMBIE_72H"
  | "ENGINEER_IDLE"
  | "MEMORY_VIOLATED";

export interface Anomaly {
  type: AnomalyType;
  issueId?: string;
  agentId?: string;
  stalledHours?: number;
  details?: Record<string, unknown>;
}

export interface IssueSnapshot {
  id: string;
  identifier?: string;
  title?: string;
  status: string;
  priority?: string;
  updatedAt: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  blockedBy?: Array<{ id: string; status: string }>;
}

export interface AgentScanResult {
  agentId: string;
  name: string;
  activeIssues: number;
  stalledIssues: number;
  maxStalledHours: number;
  anomalies: Anomaly[];
}

export interface ScanResult {
  scan: string;
  anomalies: Anomaly[];
  scanned: number;
}

export interface EngineerScanResult {
  scan: "engineer_utilization";
  engineers: AgentScanResult[];
  totalAnomalies: number;
}

// ────────────────────────────────────────────────
// Scan 1 — Active P0/P1 Check (§2.2)
// ────────────────────────────────────────────────

export function scanP0P1(
  issues: IssueSnapshot[],
  config: HorizonScanConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): ScanResult {
  const anomalies: Anomaly[] = [];

  for (const issue of issues) {
    const stalledHours = hoursSince(issue.updatedAt, now);

    if (issue.priority === "critical" && stalledHours > config.p0StallHours) {
      anomalies.push({
        type: "P0_STALLED",
        issueId: issue.id,
        stalledHours,
        details: { threshold: config.p0StallHours },
      });
    } else if (issue.priority === "high" && stalledHours > config.p1StallHours) {
      anomalies.push({
        type: "P1_STALLED",
        issueId: issue.id,
        stalledHours,
        details: { threshold: config.p1StallHours },
      });
    }

    // Blocker chain > 2 layers: issue is blocked AND at least one blocker is also blocked
    if (
      issue.status === "blocked" &&
      issue.blockedBy &&
      issue.blockedBy.some((b) => b.status === "blocked")
    ) {
      anomalies.push({
        type: "BLOCKER_CHAIN",
        issueId: issue.id,
        details: { blockerCount: issue.blockedBy.length },
      });
    }
  }

  return { scan: "p0_p1", anomalies, scanned: issues.length };
}

// ────────────────────────────────────────────────
// Scan 2 — Outstanding Asks > 30min (§2.3)
// ────────────────────────────────────────────────

export function scanOutstandingAsks(
  issues: IssueSnapshot[],
  config: HorizonScanConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): ScanResult {
  const anomalies: Anomaly[] = [];

  for (const issue of issues) {
    if (issue.status !== "in_review") continue;

    const idleMinutes = minutesSince(issue.updatedAt, now);

    if (issue.assigneeUserId) {
      // Waiting on board (human); escalate sooner
      if (idleMinutes > config.boardWaitEscalateMinutes) {
        anomalies.push({
          type: "BOARD_WAIT_LONG",
          issueId: issue.id,
          details: { idleMinutes, threshold: config.boardWaitEscalateMinutes },
        });
      }
    } else if (idleMinutes > config.outstandingAskMinutes) {
      anomalies.push({
        type: "REVIEW_STALLED",
        issueId: issue.id,
        details: { idleMinutes, threshold: config.outstandingAskMinutes },
      });
    }
  }

  return { scan: "outstanding_asks", anomalies, scanned: issues.length };
}

// ────────────────────────────────────────────────
// Scan 3 — Engineer Utilization (§2.4, 3-level alert)
// ────────────────────────────────────────────────

export interface EngineerIssueSet {
  agentId: string;
  name: string;
  issues: IssueSnapshot[];
}

export function scanEngineerUtilization(
  engineers: EngineerIssueSet[],
  config: HorizonScanConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): EngineerScanResult {
  const results: AgentScanResult[] = [];

  for (const eng of engineers) {
    const activeIssues = eng.issues.filter((i) =>
      ["in_progress", "in_review", "blocked"].includes(i.status),
    );

    const engAnomalies: Anomaly[] = [];

    if (activeIssues.length === 0) {
      engAnomalies.push({ type: "ENGINEER_IDLE", agentId: eng.agentId });
      results.push({
        agentId: eng.agentId,
        name: eng.name,
        activeIssues: 0,
        stalledIssues: 0,
        maxStalledHours: 0,
        anomalies: engAnomalies,
      });
      continue;
    }

    const stalledHoursPerIssue = activeIssues.map((i) => ({
      issue: i,
      hours: hoursSince(i.updatedAt, now),
    }));

    const maxStalledHours = Math.max(...stalledHoursPerIssue.map((x) => x.hours));

    // LEVEL-3: any in_review issue has been stalled > zombie threshold
    for (const { issue, hours } of stalledHoursPerIssue) {
      if (issue.status === "in_review" && hours > config.engineerReviewZombieHours) {
        engAnomalies.push({
          type: "REVIEW_ZOMBIE_72H",
          issueId: issue.id,
          agentId: eng.agentId,
          stalledHours: hours,
          details: { threshold: config.engineerReviewZombieHours },
        });
      }
    }

    // LEVEL-2: ALL active issues stalled >= L2 threshold
    const allStalledL2 = stalledHoursPerIssue.every(
      (x) => x.hours >= config.engineerStallL2Hours,
    );
    if (allStalledL2) {
      engAnomalies.push({
        type: "ENGINEER_ALL_STALLED_48H",
        agentId: eng.agentId,
        stalledHours: maxStalledHours,
        details: {
          issueCount: activeIssues.length,
          threshold: config.engineerStallL2Hours,
        },
      });
    } else {
      // LEVEL-1: any active issue stalled > L1 threshold (only if not already escalated to L2)
      for (const { issue, hours } of stalledHoursPerIssue) {
        if (hours > config.engineerStallL1Hours) {
          engAnomalies.push({
            type: "ENGINEER_ISSUE_STALLED_24H",
            issueId: issue.id,
            agentId: eng.agentId,
            stalledHours: hours,
            details: { threshold: config.engineerStallL1Hours },
          });
        }
      }
    }

    results.push({
      agentId: eng.agentId,
      name: eng.name,
      activeIssues: activeIssues.length,
      stalledIssues: stalledHoursPerIssue.filter(
        (x) => x.hours > config.engineerStallL1Hours,
      ).length,
      maxStalledHours,
      anomalies: engAnomalies,
    });
  }

  const totalAnomalies = results.reduce((sum, r) => sum + r.anomalies.length, 0);
  return { scan: "engineer_utilization", engineers: results, totalAnomalies };
}

// ────────────────────────────────────────────────
// Scan 4 — Memory Violations (§2.5)
// Accepts output from VOG-5786 memory_check_prompt_v1
// ────────────────────────────────────────────────

export interface MemoryCheckOutput {
  violations: Array<{ agentId?: string; description: string }>;
}

export function scanMemoryViolations(output: MemoryCheckOutput): ScanResult {
  const anomalies: Anomaly[] = output.violations.map((v) => ({
    type: "MEMORY_VIOLATED" as AnomalyType,
    agentId: v.agentId,
    details: { description: v.description },
  }));
  return { scan: "memory_violations", anomalies, scanned: output.violations.length };
}

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

function hoursSince(isoTimestamp: string, now: Date): number {
  const then = new Date(isoTimestamp);
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60);
}

function minutesSince(isoTimestamp: string, now: Date): number {
  return hoursSince(isoTimestamp, now) * 60;
}
