/** The SDK has no provider implementation or control-plane dependencies. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export const HARNESS_PROTOCOL_SCHEMA = "paperclip.harness.v1" as const;
export const HARNESS_PROTOCOL_VERSION = 1 as const;
export const HARNESS_MAX_FRAME_BYTES = 1024 * 1024;
export const HARNESS_MAX_JSON_DEPTH = 64;
export const HARNESS_MAX_JSON_NODES = 65_536;

export const RUNNER_HARNESS_PLATFORMS = [
  "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64",
] as const;
export type RunnerHarnessPlatform = typeof RUNNER_HARNESS_PLATFORMS[number];

/** Capability claims are verified by the runtime handshake and qualification. */
export type RunnerHarnessCapabilities = Record<string, boolean>;

export interface RunnerHarnessCredentialDeclaration {
  /** Selected credential's environment key; process-control keys are forbidden. */
  key: string;
  displayName: string;
  required: boolean;
}

/** Declarative contribution in a Paperclip plugin's runnerHarnesses array. */
export interface RunnerHarnessDeclaration {
  harnessKey: string;
  displayName: string;
  configSchema: JsonObject;
  platforms: RunnerHarnessPlatform[];
  capabilities: RunnerHarnessCapabilities;
  runtime: {
    /** Prebuilt executable entrypoint relative to the installed package. */
    entrypoint: string;
    sha256: string;
  };
  credentials?: RunnerHarnessCredentialDeclaration[];
}

/** Immutable admission identity. Credentials and executable paths are excluded. */
export interface RunnerHarnessReleaseIdentity {
  harnessId: string;
  packageName: string;
  version: string;
  integrity: string;
  protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
  runtimeDigest: string;
}

export type HarnessReleaseIdentity = RunnerHarnessReleaseIdentity;

export interface RunnerHarnessLaunchArtifact {
  path: string;
  sha256: string;
}

/** Execution-owner input. Never accepted from a task's provider configuration. */
export interface RunnerHarnessLaunchProfile {
  schema: "paperclip.harness-launch.v1";
  identity: RunnerHarnessReleaseIdentity;
  command: RunnerHarnessLaunchArtifact;
  entrypoint?: RunnerHarnessLaunchArtifact;
  args: string[];
  environmentKeys: string[];
}

/** Provider-owned conversation state bound to its exact admitted runtime. */
export interface RunnerHarnessCheckpoint {
  schema: "paperclip.harness-checkpoint.v1";
  identity: RunnerHarnessReleaseIdentity;
  normalizedSessionId: string;
  model: string;
  config: JsonObject;
  cwd?: string;
  runtimeDirectory?: string;
  accountIdentity?: string;
  credentialIdentity?: string;
  /** Stable native identities observed and retained by Runner, never inferred. */
  providerSessionIdentity?: { providerSessionId: string; backendSessionId: string };
  providerState: JsonObject;
  /** The old process group must be absent before a fresh runtime imports this. */
  processGroup: number | null;
}

/** Runner owns validation, authority and durable command deduplication. */
export interface HarnessCommand {
  schema: "paperclip.prp.command.v1" | "paperclip.prp.command.v2" | "paperclip.prp.command.v3";
  commandId: string;
  controllerSeq: number;
  type: string;
  issuedAt: string;
  deadlineAt?: string | null;
  precondition?: JsonObject | null;
  payload: JsonObject;
}

export type HarnessMethod = "initialize" | "execute" | "snapshot" | "close";
export interface HarnessRequest {
  schema: typeof HARNESS_PROTOCOL_SCHEMA;
  id: number;
  method: HarnessMethod;
  params: JsonObject;
}
export interface HarnessError {
  code: string;
  message: string;
  retryable: boolean;
}
export type HarnessResponse =
  | { schema: typeof HARNESS_PROTOCOL_SCHEMA; id: number; ok: true; result: JsonObject }
  | { schema: typeof HARNESS_PROTOCOL_SCHEMA; id: number; ok: false; error: HarnessError };
export type HarnessEventPriority = "p0" | "p1" | "p2";
export interface HarnessEventFact {
  eventType: string;
  priority: HarnessEventPriority;
  turnId?: string | null;
  itemId?: string | null;
  payload: JsonObject;
}
export interface HarnessEvent extends HarnessEventFact {
  schema: typeof HARNESS_PROTOCOL_SCHEMA;
  sequence: number;
}

export class HarnessProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_harness_frame") {
    super(message);
    this.name = "HarnessProtocolError";
    this.code = code;
  }
}
