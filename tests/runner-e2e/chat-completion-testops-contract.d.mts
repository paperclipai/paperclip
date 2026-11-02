export interface PilotCase {
  key: string;
  scenario: string;
  name: string;
  checks: number;
  aliases?: readonly string[];
  registeredFullName?: string;
  minimumRuns: number;
  maximumRuns: number;
  executionId: string;
  fullName: string;
}
export type CatalogCase = Omit<PilotCase, "checks"> & { checks: number | null };
export const cases: readonly Readonly<PilotCase>[];
export const targetSha: string;
export const launchSha256: string;
export const workflow: string;
export const planName: string;
export const model: string;
export function hash(value: string | Uint8Array): string;
export function validRunCount(ids: readonly string[] | undefined, descriptor: CatalogCase): boolean;
export interface PilotContext { catalog?: "full"; runId: string; attempt: string; workflowSha: string; targetSha: string }
export interface PilotSelection extends PilotContext {
  schema: string; projectId: number; planId: number; jobId: number; launchId: number;
  allureJobRunId: string; cases: (CatalogCase & { caseId: number })[];
}
export function validateSelection(selection: PilotSelection, context: PilotContext, jobRunId: string): (CatalogCase & { caseId: number })[];
export function evidencePolicy(selection: PilotSelection, context: PilotContext, jobRunId: string): {
  version: number; approvals: { workflowSha: string; targetSha: string; runId: string; attempt: string;
    executionIds: string[]; protocol: string; launchSha256: string }[];
};

export const catalogWorkflow: string;
export function catalogDefinition(context?: { catalog?: "full" }): { cases: readonly Readonly<CatalogCase>[]; planName: string; targetSha: string; workflow: string; bindingKey: string };
