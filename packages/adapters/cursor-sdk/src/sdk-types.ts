// Minimal local mirror of @cursor/sdk shapes we depend on.
//
// Why this file exists:
//   The @cursor/sdk package is in public beta and may not be installed in every
//   workspace setup (CI, smoke fixtures, fresh clones). To keep `pnpm typecheck`
//   green and the server bootable without the SDK, the adapter loads the SDK via
//   dynamic import at runtime and only uses these structural types at compile time.
//
//   When @cursor/sdk is installed, the shapes here intentionally line up with the
//   public surface so the dynamic import result can be cast directly. If the SDK
//   evolves, update this file accordingly.

export type SdkRunStatus = "running" | "finished" | "error" | "cancelled";

export type SdkSettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";

export interface SdkLocalRuntime {
  cwd?: string | string[];
  settingSources?: SdkSettingSource[];
  sandboxOptions?: { enabled: boolean };
}

export interface SdkCloudRepo {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export interface SdkCloudRuntime {
  env?: { type: "cloud" | "pool" | "machine"; name?: string };
  repos: SdkCloudRepo[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  envVars?: Record<string, string>;
}

export interface SdkModelParameterValue {
  id: string;
  value: string;
}

export interface SdkModelSelection {
  id: string;
  params?: SdkModelParameterValue[];
}

export interface SdkAgentCreateOptions {
  apiKey?: string;
  model?: SdkModelSelection;
  local?: SdkLocalRuntime;
  cloud?: SdkCloudRuntime;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}

export interface SdkSendOptions {
  apiKey?: string;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  onDelta?: (event: { update: unknown }) => void;
  onStep?: (event: { step: unknown }) => void;
}

// Discriminated union returned by run.stream(). Treat every payload field as
// unknown — the SDK calls the schema unstable for tool args/results.
export type SdkMessage =
  | { type: "system"; subtype?: string; model?: string; agentId?: string; tools?: unknown }
  | { type: "user"; message?: unknown; text?: string }
  | { type: "assistant"; message?: unknown; text?: string }
  | { type: "thinking"; text?: string; delta?: { text?: string }; subtype?: string }
  | { type: "tool_call"; subtype?: string; call_id?: string; name?: string; tool_call?: unknown; status?: string; args?: unknown; result?: unknown; is_error?: boolean }
  | { type: "status"; status?: string; runStatus?: SdkRunStatus }
  | { type: "task"; subtype?: string; text?: string }
  | { type: "request"; subtype?: string; text?: string; prompt?: string }
  | { type: string; [key: string]: unknown };

export interface SdkRunResult {
  status: SdkRunStatus;
  result?: string;
  durationMs?: number;
  git?: { branch?: string; prUrl?: string; commit?: string };
  errorMessage?: string;
}

export interface SdkRun {
  readonly id: string;
  readonly agentId: string;
  readonly status: SdkRunStatus;
  readonly result?: string;
  readonly model?: SdkModelSelection;
  readonly durationMs?: number;
  readonly git?: { branch?: string; prUrl?: string; commit?: string };
  stream(): AsyncIterable<SdkMessage>;
  wait(): Promise<SdkRunResult>;
  cancel(): Promise<void>;
  conversation?: () => Promise<unknown>;
  onDidChangeStatus?: (listener: (status: SdkRunStatus) => void) => () => void;
}

export interface SdkAgent {
  readonly agentId: string;
  send(message: string | { text: string }, options?: SdkSendOptions): Promise<SdkRun>;
  close?: () => void;
  reload?: () => Promise<void>;
  [Symbol.asyncDispose]?: () => Promise<void>;
  listArtifacts?: () => Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>>;
  downloadArtifact?: (path: string) => Promise<Buffer>;
}

export interface SdkAgentStatic {
  create(options: SdkAgentCreateOptions): Promise<SdkAgent>;
  resume(agentId: string, options?: Partial<SdkAgentCreateOptions>): Promise<SdkAgent>;
  get?: (agentId: string, options?: { apiKey?: string }) => Promise<{ status?: SdkRunStatus; archived?: boolean } | null>;
}

export interface SdkCursorNamespace {
  me?: (options?: { apiKey?: string }) => Promise<{ apiKeyName?: string; userEmail?: string }>;
  models?: { list?: (options?: { apiKey?: string }) => Promise<Array<{ id: string; displayName?: string }>> };
}

export interface SdkModule {
  Agent: SdkAgentStatic;
  Cursor?: SdkCursorNamespace;
}

/**
 * Dynamically loads @cursor/sdk. Returns null when the SDK is not installed —
 * callers MUST surface a clear error to the run log in that case.
 */
export async function loadCursorSdk(): Promise<SdkModule | null> {
  try {
    // Avoid a static import so missing SDK doesn't crash server boot.
    const mod = (await import("@cursor/sdk" as string)) as unknown;
    if (mod && typeof mod === "object" && "Agent" in mod) {
      return mod as SdkModule;
    }
    return null;
  } catch {
    return null;
  }
}
