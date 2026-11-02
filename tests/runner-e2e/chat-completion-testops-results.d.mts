import type { RunnerE2EResult } from "./types.js";
import type { PilotCase } from "./chat-completion-testops-contract.mjs";
interface Context { runId: string; attempt: string; workflowSha: string; targetSha: string }
interface Selection extends Context {
  schema: string; projectId: number; planId: number; jobId: number; launchId: number;
  allureJobRunId: string; cases: (PilotCase & { caseId: number })[];
}
export interface PilotOutcome {
  caseId: number; executionId: string; status: "passed" | "failed"; cleanup: string;
  attachments: { name: string; contentType: string; contentLength: number }[];
}
export function readPilotExport(root: string, context: Context, selection: Selection): Promise<{
  campaign: { campaignId: string; results: RunnerE2EResult[] };
  selected: (PilotCase & { caseId: number })[]; retained: Map<string, Buffer>;
  privateEvidence: { executionId: string; requiredEvidenceComplete: boolean | null; finalScreenshot: { sha256: string; bytes: number } | null }[];
}>;
export function exportPilotAllure(root: string, output: string, context: Context, selection: Selection): Promise<PilotOutcome[]>;
