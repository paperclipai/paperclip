import { ChaosApiError } from "./api.js";
import type { HostedApi } from "./hosted-api.js";
import type { RetryBanner } from "./hosted-workload.js";
import type { ReleaseSwapResult } from "./release-swap-grade.js";

type Json = Record<string, any>;

export interface HandsOffSummary {
  completedHandsOff: number;
  started: number;
  bannerShown: number;
  bannerClearedByItself: number;
  retryClicked: number;
  retryWorked: number;
  lines: [string, string, string];
}

export function handsOffSummary(result: Pick<ReleaseSwapResult, "completedWithoutHuman" | "started" | "retry">, issueIds: readonly string[],
  banners: ReadonlyMap<string, RetryBanner>): HandsOffSummary {
  const shown = issueIds.filter(id => banners.has(id));
  const cleared = shown.filter(id => banners.get(id)!.clearedByItself && !banners.get(id)!.shown).length;
  const summary = { completedHandsOff: result.completedWithoutHuman, started: result.started, bannerShown: shown.length, bannerClearedByItself: cleared,
    retryClicked: result.retry.tasks, retryWorked: result.retry.worked };
  return { ...summary, lines: [
    `${summary.completedHandsOff} / ${summary.started} tasks completed hands-off`,
    `Retry banner shown: ${summary.bannerShown} (cleared by itself: ${summary.bannerClearedByItself})`,
    `Retry worked / clicked: ${summary.retryWorked} / ${summary.retryClicked}`,
  ] };
}

export interface InvariantCounts {
  available: boolean;
  status: number | null;
  company?: { openTasks: number; checked: number; truncated: boolean; violationCount: number; violations: Record<string, number>; stalledSlotAgents: number };
  run?: { sampledViolations: number; byReason: Record<string, number>; stalledSlots: Array<{ agentName: string; stalledRuns: number; queuedRuns: number }> };
}

export async function readAssignedWorkInvariant(api: Pick<HostedApi, "get">, companyId: string,
  ours: { identifiers: ReadonlySet<string>; agentNames: ReadonlySet<string> }): Promise<InvariantCounts> {
  let report: Json;
  try {
    report = await api.get<Json>(`/api/companies/${companyId}/assigned-work-invariant`);
  } catch (error) {
    return { available: false, status: error instanceof ChaosApiError ? error.status : null };
  }
  const sample = ((report.sample ?? []) as Json[]).filter(entry => entry.identifier && ours.identifiers.has(String(entry.identifier)));
  const byReason: Record<string, number> = {};
  for (const entry of sample) byReason[String(entry.reason)] = (byReason[String(entry.reason)] ?? 0) + 1;
  const slots = (report.agentsWithStalledSlots ?? []) as Json[];
  return {
    available: true, status: 200,
    company: { openTasks: Number(report.openTasks ?? 0), checked: Number(report.checked ?? 0), truncated: Boolean(report.truncated),
      violationCount: Number(report.violationCount ?? 0), violations: { ...(report.violations ?? {}) }, stalledSlotAgents: slots.length },
    run: { sampledViolations: sample.length, byReason,
      stalledSlots: slots.filter(slot => ours.agentNames.has(String(slot.agentName))).map(slot => ({ agentName: String(slot.agentName),
        stalledRuns: Number(slot.stalledRuns ?? 0), queuedRuns: Number(slot.queuedRuns ?? 0) })) },
  };
}

export function invariantLine(counts: InvariantCounts): string {
  if (!counts.available) return `Assigned-work invariant: not available on this build (HTTP ${counts.status ?? "no answer"}).`;
  const company = counts.company!, run = counts.run!;
  const reasons = Object.entries(company.violations).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none";
  return `Assigned-work invariant: company ${company.violationCount} violation(s) over ${company.openTasks} open task(s)${company.truncated ? " (lower bound)" : ""} [${reasons}], `
    + `${company.stalledSlotAgents} agent(s) with stalled slots; this run: ${run.sampledViolations} sampled violation(s), ${run.stalledSlots.length} agent(s) with stalled slots.`;
}
