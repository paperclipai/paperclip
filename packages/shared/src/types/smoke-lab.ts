export const SMOKE_RUN_TRIGGERS = ["manual", "routine", "ci"] as const;
export type SmokeRunTrigger = (typeof SMOKE_RUN_TRIGGERS)[number];

export const SMOKE_RUN_STATUSES = ["running", "passed", "failed", "cancelled"] as const;
export type SmokeRunStatus = (typeof SMOKE_RUN_STATUSES)[number];

export const SMOKE_RUN_STEP_PATHS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"] as const;
export type SmokeRunStepPath = (typeof SMOKE_RUN_STEP_PATHS)[number];

export const SMOKE_RUN_STEP_STATUSES = ["pass", "fail", "skipped"] as const;
export type SmokeRunStepStatus = (typeof SMOKE_RUN_STEP_STATUSES)[number];

export interface SmokeRun {
  id: string;
  companyId: string;
  trigger: SmokeRunTrigger;
  status: SmokeRunStatus;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  summary: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SmokeRunStep {
  id: string;
  companyId: string;
  runId: string;
  path: SmokeRunStepPath;
  scenarioStep: string;
  status: SmokeRunStepStatus;
  detail: string | null;
  screenshotArtifactRef: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SmokeLabServiceStatus {
  id: "fake-oauth" | "http-mcp-fixture";
  label: string;
  status: "stopped" | "running" | "error";
  url: string | null;
  health: Record<string, unknown> | null;
  detail: string | null;
}
