import type {
  PrpCapabilities,
  PrpCommand,
  PrpEvent,
  PrpIdentity,
  PrpRequest,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";

export const LOCAL_RUNNER_SCENARIOS = [
  "happy-path",
  "permission-input",
  "interrupted",
  "error",
  "duplicate-terminal",
] as const;

export type LocalRunnerScenario = (typeof LOCAL_RUNNER_SCENARIOS)[number];

export interface LocalRunnerCommandReceipt {
  commandId: string;
  controllerSeq: number;
  status: "accepted" | "duplicate" | "rejected";
  detail: string;
}

export interface LocalRunnerProcessExitFact {
  exitCode: number | null;
  success: boolean;
  signal: number | null;
}

export interface LocalRunnerRunMetadata {
  schema: "paperclip.runner.local-runner.metadata.v1";
  scenario: LocalRunnerScenario;
  fixtureName: string;
  identity: PrpIdentity;
  capabilities: PrpCapabilities;
}

export interface LocalRunnerRunTrace extends Omit<LocalRunnerRunMetadata, "schema"> {
  schema: "paperclip.runner.local-runner.trace.v1";
  commands: PrpCommand[];
  commandReceipts: LocalRunnerCommandReceipt[];
  events: PrpEvent[];
  requests: PrpRequest[];
  result: PrpStructuredRunResult | null;
  harnessProcessExit: LocalRunnerProcessExitFact | null;
  runnerProcessExit: { code: number | null; signal: string | null };
  runnerDiagnostics: string[];
}
