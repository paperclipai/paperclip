export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunnerGeneration = "direct" | "native";
export type ExpectedRuntimeMode = "legacy" | "native";
export type NativeProvider = "codex" | "opencode" | "acpx";
export type QualifiedAcpxAgent = "claude" | "codex";

export interface RunnerAcceptanceProfile {
  id: string;
  label: string;
  generation: RunnerGeneration;
  adapterScope: "built_in" | "external_plugin_contract";
  adapterType: string;
  expectedRuntimeMode: ExpectedRuntimeMode;
  provider: NativeProvider | null;
  model: string | null;
  adapterConfig: Readonly<Record<string, JsonValue>>;
  invariants: readonly string[];
}

export interface RunnerAcceptanceCase {
  id: string;
  label: string;
  revision: number;
  appliesTo: "all" | RunnerGeneration;
  assertions: readonly string[];
}

export interface RunnerAcceptanceCell {
  id: string;
  suiteId: "runner-compatibility";
  suiteDefinitionHash: string;
  profile: RunnerAcceptanceProfile;
  acceptanceCase: RunnerAcceptanceCase;
  assertions: readonly string[];
}

export type FailureClass =
  | "candidate_failure"
  | "transient_infrastructure"
  | "permanent_infrastructure"
  | "secret_leak"
  | "cleanup_failure";

export interface AcceptanceAssertionResult {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface RunnerAcceptanceResult {
  schema: "paperclip.runner-acceptance.result/v1";
  cellId: string;
  attempt: number;
  status: "passed" | "failed";
  failureClass?: FailureClass;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  redaction: "passed" | "failed";
  assertions: readonly AcceptanceAssertionResult[];
}

export interface AggregatedAcceptanceResult extends RunnerAcceptanceResult {
  valid: boolean;
  validationErrors: readonly string[];
}

export interface RunnerAcceptanceReport {
  schema: "paperclip.runner-acceptance.report/v1";
  generatedAt: string;
  suiteDefinitionHash: string;
  selected: number;
  passed: number;
  failed: number;
  retries: number;
  results: readonly AggregatedAcceptanceResult[];
}
