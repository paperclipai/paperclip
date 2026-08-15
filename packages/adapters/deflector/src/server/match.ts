import { homedir } from "node:os";
import { join } from "node:path";

export type ConfidenceTier = "high" | "medium" | "low";

export interface PatternRule {
  id: string;
  name: string;
  /** Regex tested against issue title (case-insensitive). */
  titleRegex: string;
  /** Exact originKind match when set. */
  originKind: string | null;
  /** When true, originId must resolve to a terminal status (done|cancelled). */
  requireOriginTerminal: boolean;
  resolutionStatus: "done" | "cancelled";
  commentTemplate: string;
  companyScope: "all" | string;
  confidence: ConfidenceTier;
  sourceCluster: string;
  enabled: boolean;
}

export interface MatchCandidate {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    originKind: string | null;
    originId: string | null;
    companyId: string | null;
    status: string | null;
  };
  originStatus: string | null;
}

export interface MatchResult {
  matched: boolean;
  pattern: PatternRule | null;
  reason: string;
}

export const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export function defaultKbPath(): string {
  return join(homedir(), ".paperclip", "instances", "default", "deflector", "kb.sqlite");
}

export function defaultAuditPath(): string {
  return join(homedir(), ".paperclip", "instances", "default", "deflector", "audit.jsonl");
}

export function matchIssue(patterns: PatternRule[], candidate: MatchCandidate): MatchResult {
  const title = candidate.issue.title ?? "";
  const companyId = candidate.issue.companyId ?? "";

  for (const pattern of patterns) {
    if (!pattern.enabled) continue;
    if (pattern.confidence !== "high") {
      // Conservative: only high-confidence patterns auto-resolve in v1.
      continue;
    }
    if (pattern.companyScope !== "all" && pattern.companyScope !== companyId) {
      continue;
    }
    if (pattern.originKind && pattern.originKind !== (candidate.issue.originKind ?? "")) {
      continue;
    }

    let titleOk = false;
    try {
      titleOk = new RegExp(pattern.titleRegex, "i").test(title);
    } catch {
      continue;
    }
    if (!titleOk) continue;

    if (pattern.requireOriginTerminal) {
      if (!candidate.originStatus || !TERMINAL_STATUSES.has(candidate.originStatus)) {
        // Title/originKind looked right but origin is still open — do not auto-resolve.
        continue;
      }
    }

    return {
      matched: true,
      pattern,
      reason: `matched ${pattern.id}`,
    };
  }

  return { matched: false, pattern: null, reason: "no high-confidence pattern matched" };
}

/** Built-in seed patterns used when KB is empty or for unit tests. */
export const SEED_PATTERNS: PatternRule[] = [
  {
    id: "stranded_issue_recovery_source_terminal",
    name: "Stranded recovery when source already terminal",
    titleRegex: "^Recover (stalled issue|missing next step)\\b",
    originKind: "stranded_issue_recovery",
    requireOriginTerminal: true,
    resolutionStatus: "done",
    commentTemplate:
      "Resolved by Deflector — pattern: stranded_issue_recovery_source_terminal (source issue already {{originStatus}}).",
    companyScope: "all",
    confidence: "high",
    sourceCluster:
      "Phase0 AIP+ONS: 1780 stranded_issue_recovery tickets; 575+ cases where origin was already done/cancelled.",
    enabled: true,
  },
  {
    id: "stranded_recover_stalled_source_terminal",
    name: "Recover stalled issue — source terminal (narrow title)",
    titleRegex: "^Recover stalled issue\\b",
    originKind: "stranded_issue_recovery",
    requireOriginTerminal: true,
    resolutionStatus: "done",
    commentTemplate:
      "Resolved by Deflector — pattern: stranded_recover_stalled_source_terminal (source issue already {{originStatus}}).",
    companyScope: "all",
    confidence: "high",
    sourceCluster: "ONS+AIP Recover stalled issue cluster (1449 titles).",
    enabled: true,
  },
];
