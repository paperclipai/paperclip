import type {
  PrpCapabilities,
  PrpCommand,
  PrpEvent,
  PrpIdentity,
  PrpRequest,
  PrpStructuredRunResult,
} from "../protocol/phase1-contract.js";

export const PHASE2_SCENARIOS = [
  "happy-path",
  "permission-input",
  "interrupted",
  "error",
  "duplicate-terminal",
] as const;

export type Phase2Scenario = (typeof PHASE2_SCENARIOS)[number];

export interface Phase2CommandReceipt {
  commandId: string;
  controllerSeq: number;
  status: "accepted" | "duplicate" | "rejected";
  detail: string;
}

export interface Phase2ProcessExitFact {
  exitCode: number | null;
  success: boolean;
  signal: number | null;
}

export interface Phase2RunMetadata {
  schema: "paperclip.runner.phase2.metadata.v1";
  scenario: Phase2Scenario;
  fixtureName: string;
  identity: PrpIdentity;
  capabilities: PrpCapabilities;
}

export interface Phase2RunTrace extends Omit<Phase2RunMetadata, "schema"> {
  schema: "paperclip.runner.phase2.trace.v1";
  commands: PrpCommand[];
  commandReceipts: Phase2CommandReceipt[];
  events: PrpEvent[];
  requests: PrpRequest[];
  result: PrpStructuredRunResult | null;
  harnessProcessExit: Phase2ProcessExitFact | null;
  runnerProcessExit: { code: number | null; signal: string | null };
  runnerDiagnostics: string[];
}
