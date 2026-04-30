import { createHash } from "node:crypto";
import type { CheckStatus, NotifyChannel, ThresholdSeverity } from "./types.js";

const SEVERITY_RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, error: 2 };

export interface ShouldNotifyArgs {
  channel: NotifyChannel;
  thresholdSeverity?: ThresholdSeverity;
  currentStatus: CheckStatus;
  previousStatus: CheckStatus | null;
  findings: number;
}

export function shouldNotify(a: ShouldNotifyArgs): boolean {
  const stateChange = a.previousStatus !== null && a.previousStatus !== a.currentStatus;
  const recoveryFromBad =
    stateChange &&
    a.previousStatus !== null &&
    SEVERITY_RANK[a.previousStatus] > 0 &&
    a.currentStatus === "ok";

  switch (a.channel) {
    case "silent":
      return recoveryFromBad;
    case "threshold": {
      const meetsThreshold =
        a.thresholdSeverity !== undefined &&
        SEVERITY_RANK[a.currentStatus] >= SEVERITY_RANK[a.thresholdSeverity];
      return meetsThreshold || stateChange;
    }
    case "telegram":
      return a.findings > 0 || stateChange;
  }
}

export interface BuildSummaryArgs {
  original: string;
  previousStatus: CheckStatus | null;
  currentStatus: CheckStatus;
}

export function buildSummary(a: BuildSummaryArgs): string {
  const recovery =
    a.previousStatus !== null &&
    SEVERITY_RANK[a.previousStatus] > 0 &&
    a.currentStatus === "ok";
  return recovery ? `✅ recovery — ${a.original}` : a.original;
}

export interface ContentHashInput {
  summary: string;
  findings: number;
  examples: string[];
}

export function computeContentHash(i: ContentHashInput): string {
  const top3 = i.examples.slice(0, 3).join("|");
  const raw = `${i.summary} ${i.findings} ${top3}`;
  return `sha256-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}
