export interface PilotCase {
  key: "control" | "defaults" | "work";
  scenario: string;
  name: string;
  checks: number;
  minimumRuns: number;
  maximumRuns: number;
  executionId: string;
  fullName: string;
}
export const cases: readonly Readonly<PilotCase>[];
export const targetSha: string;
export const launchSha256: string;
export const workflow: string;
export const planName: string;
export const model: string;
export function hash(value: string | Uint8Array): string;
export function validRunCount(ids: readonly string[] | undefined, descriptor: PilotCase): boolean;
export interface PilotContext { runId: string; attempt: string; workflowSha: string; targetSha: string }
export interface PilotSelection extends PilotContext {
  schema: string; projectId: number; planId: number; jobId: number; launchId: number;
  allureJobRunId: string; cases: (PilotCase & { caseId: number })[];
}
export function validateSelection(selection: PilotSelection, context: PilotContext, jobRunId: string): (PilotCase & { caseId: number })[];
export function evidencePolicy(selection: PilotSelection, context: PilotContext, jobRunId: string): {
  version: number; approvals: { workflowSha: string; targetSha: string; runId: string; attempt: string;
    executionIds: string[]; protocol: string; launchSha256: string }[];
};
