// ---------------------------------------------------------------------------
// Minimal adapter-facing interfaces (no drizzle dependency)
// ---------------------------------------------------------------------------

export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

export interface AdapterRuntime {
  /**
   * Legacy single session id view. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

// ---------------------------------------------------------------------------
// Execution types (moved from server/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AdapterBillingType =
  | "api"
  | "api_key"
  | "subscription"
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";

// ---------------------------------------------------------------------------
// Failover decision log schema (ROCAA-22 / ROCAA-27)
// ---------------------------------------------------------------------------

/**
 * Identifier for which execution tier produced a given result. v1 covers the
 * claude_local Tier 0 (claude CLI subscription) → Tier 1 (Anthropic SDK
 * metered API key) failover. Adapters that don't participate in tiered
 * failover leave these fields unset.
 */
export type AdapterTierUsed = "tier_0_claude_cli" | "tier_1_anthropic_sdk";

/**
 * Stable id for *why* the executor moved between tiers. Subset of the
 * claude_local classifier's recoverability reasons — only the ones that
 * fire a Tier 0 → Tier 1 transition. Non-recoverable failures and the
 * happy path do not produce a transition entry.
 */
export type AdapterTierTransitionReason =
  | "rate_limit"
  | "token_refresh_transient"
  | "network_econnreset"
  | "network_etimedout"
  | "network_fetch_failed"
  | "anthropic_5xx"
  | "claude_cli_panic"
  | "malformed_stream_json";

/**
 * One recorded transition between execution tiers. Bounded to length ≤ 1 in
 * v1 by the wiring layer (the classifier is never called on a Tier 1 outcome).
 */
export interface AdapterTierTransition {
  /** ISO 8601 UTC, set when the transition decision is made. */
  at: string;
  /** Tier that just failed. */
  from: AdapterTierUsed;
  /** Tier the executor moved to. */
  to: AdapterTierUsed;
  /** Stable reason id from the classifier verdict. */
  reason: AdapterTierTransitionReason;
  /** Regex/parsed-field marker the classifier matched on. Truncated to 240 chars. */
  classifierMatch: string | null;
  /** Free-form short detail for humans. ≤ 240 chars. */
  detail?: string;
  /** Exit code of the failing attempt, for forensics. */
  fromExitCode: number | null;
  /** Whether the failing attempt produced a parsed JSON result. */
  fromParsed: boolean;
}

/**
 * Run-meta payload the wiring layer emits via `onMeta({ failoverEvent })`
 * when a Tier 0 → Tier 1 transition fires. The run UI reads this to render
 * a "Tier 1 (API key)" pill on the run card so operators can see *which
 * budget* the invocation will spend.
 */
export interface AdapterFailoverEvent {
  at: string;
  from: AdapterTierUsed;
  to: AdapterTierUsed;
  reason: AdapterTierTransitionReason;
  classifierMatch: string | null;
  /** Operator-facing name of the credential Tier 1 is using (e.g. secret name). */
  billerKeyName: string;
}

export interface AdapterRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  /**
   * Legacy single session id output. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  runtimeServices?: AdapterRuntimeServiceReport[];
  summary?: string | null;
  clearSession?: boolean;
  question?: {
    prompt: string;
    choices: Array<{
      key: string;
      label: string;
      description?: string;
    }>;
  } | null;
  // -------------------------------------------------------------------------
  // Failover decision log fields (ROCAA-22 / ROCAA-27 log schema).
  //
  // Added at top level (sibling to `exitCode`, `usage`, `provider`, `biller`)
  // so downstream consumers — run pipeline, run UI, governance — can render
  // them without parsing a nested JSON. The wiring layer in claude-local
  // always populates all three when failover-aware execution is used; other
  // adapters leave them unset.
  // -------------------------------------------------------------------------
  /** Which tier actually produced the returned result. */
  tierUsed?: AdapterTierUsed;
  /** 0 entries on plain success; 1 entry on Tier 0→Tier 1; never 2+ in v1. */
  tierTransitions?: AdapterTierTransition[];
  /** Version string for the classifier that produced any transitions, e.g. "1.0.0". */
  classifierVersion?: string;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

/**
 * Cost-cap block payload (ROCAA-23). Emitted on `AdapterInvocationMeta` by
 * the wiring layer when a Tier 1 attempt was refused by the daily or
 * per-issue cap gate. Distinct from `failoverEvent` so consumers can
 * structurally tell "would-have-failed-over but was capped" apart from a
 * normal Tier 0 success.
 */
export interface AdapterCostCapBlock {
  reason: "daily_cap_tripped" | "per_issue_cap_tripped";
  detail: string;
  /** When the block will lift (daily cap only). null for per-issue caps. */
  resetAt: string | null;
  issueId: string | null;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
  /**
   * Set by the wiring layer when a Tier 0 → Tier 1 failover transition fires.
   * The run UI reads this to render the "Tier 1 (API key)" pill on the run
   * card; the field is absent on non-transition invocations.
   */
  failoverEvent?: AdapterFailoverEvent;
  /**
   * Set by the wiring layer when a Tier 1 attempt was refused by the
   * ROCAA-23 cost-cap gate before the SDK call fired. Carries the structured
   * reason so the run UI can render a "Capped" pill and operators can route
   * the appropriate cap-rotation playbook.
   */
  costCapBlock?: AdapterCostCapBlock;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  authToken?: string;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export type AdapterSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AdapterSkillOrigin =
  | "company_managed"
  | "paperclip_required"
  | "user_installed"
  | "external_unknown";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: AdapterSkillState;
  origin?: AdapterSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AdapterSkillSyncMode;
  desiredSkills: string[];
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  deployment?: {
    mode?: "local_trusted" | "authenticated";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

/** Payload for the onHireApproved adapter lifecycle hook (e.g. join-request or hire_agent approval). */
export interface HireApprovedPayload {
  companyId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  /** "join_request" | "approval" */
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt: string;
  /** Canonical operator-facing message for cloud adapters to show the user. */
  message: string;
}

/** Result of onHireApproved hook; failures are non-fatal to the approval flow. */
export interface HireApprovedHookResult {
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Quota window types — used by adapters that can report provider quota/rate-limit state
// ---------------------------------------------------------------------------

/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/** result for one provider from getQuotaWindows() */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}

// ---------------------------------------------------------------------------
// Adapter config schema — declarative UI config for external adapters
// ---------------------------------------------------------------------------

export interface ConfigFieldOption {
  label: string;
  value: string;
  /** Optional group key for categorizing options (e.g. provider name) */
  group?: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  /** Optional metadata — not rendered, but available to custom UI logic */
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (ctx: AdapterSkillContext, desiredSkills: string[]) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: import("./session-compaction.js").AdapterSessionManagement;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
  agentConfigurationDoc?: string;
  /**
   * Optional lifecycle hook when an agent is approved/hired (join-request or hire_agent approval).
   * adapterConfig is the agent's adapter config so the adapter can e.g. send a callback to a configured URL.
   */
  onHireApproved?: (
    payload: HireApprovedPayload,
    adapterConfig: Record<string, unknown>,
  ) => Promise<HireApprovedHookResult>;
  /**
   * Optional: fetch live provider quota/rate-limit windows for this adapter.
   * Returns a ProviderQuotaResult so the server can aggregate across adapters
   * without knowing provider-specific credential paths or API shapes.
   */
  getQuotaWindows?: () => Promise<ProviderQuotaResult>;
  /**
   * Optional: detect the currently configured model from local config files.
   * Returns the detected model/provider and the config source, or null if
   * the adapter does not support detection or no config is found.
   */
  detectModel?: () => Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null>;
  /**
   * Optional: return a declarative config schema so the UI can render
   * adapter-specific form fields without shipping React components.
   * Dynamic options (e.g. scanning a profiles directory) should be
   * resolved inside this method — the caller receives a fully hydrated schema.
   */
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;

  // ---------------------------------------------------------------------------
  // Adapter capability flags
  //
  // These allow adapter plugins to declare what "local" capabilities they
  // support, replacing hardcoded type lists in the server and UI.
  // All flags are optional — when undefined, the server falls back to
  // legacy hardcoded lists for built-in adapters.
  // ---------------------------------------------------------------------------

  /**
   * Adapter supports managed instructions bundle (AGENTS.md files).
   * When true, the server uses instructionsPathKey (default "instructionsFilePath")
   * to resolve the instructions config key, and the UI shows the bundle editor.
   * Built-in local adapters default to true; external plugins must opt in.
   */
  supportsInstructionsBundle?: boolean;

  /**
   * The adapterConfig key that holds the instructions file path.
   * Defaults to "instructionsFilePath" when supportsInstructionsBundle is true.
   */
  instructionsPathKey?: string;

  /**
   * Adapter needs runtime skill entries materialized (written to disk)
   * before being passed via config. Used by adapters that scan a directory
   * rather than reading config.paperclipRuntimeSkills.
   */
  requiresMaterializedRuntimeSkills?: boolean;

  /**
   * Optional tool allowlist for least-privilege enforcement (ROCAA-289).
   * When present, only the listed tool names are permitted (no --yolo).
   * Enforced by adapter execution layer and hermes-paperclip-adapter shim.
   * Approved set example: ["paperclip", "vault_read", "vault_search", "terminal", "web", "rag_query"]
   */
  toolAllowlist?: string[];
}

// ---------------------------------------------------------------------------
// UI types (moved from ui/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string }
  | { kind: "diff"; ts: string; changeType: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation"; text: string };

export type StdoutLineParser = (line: string, ts: string) => TranscriptEntry[];

// ---------------------------------------------------------------------------
// CLI types (moved from cli/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export interface CLIAdapterModule {
  type: string;
  formatStdoutEvent: (line: string, debug: boolean) => void;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from ui/src/components/AgentConfigForm.tsx)
// ---------------------------------------------------------------------------

export interface CreateConfigValues {
  adapterType: string;
  cwd: string;
  instructionsFilePath?: string;
  promptTemplate: string;
  model: string;
  thinkingEffort: string;
  chrome: boolean;
  dangerouslySkipPermissions: boolean;
  search: boolean;
  fastMode: boolean;
  dangerouslyBypassSandbox: boolean;
  command: string;
  args: string;
  extraArgs: string;
  envVars: string;
  envBindings: Record<string, unknown>;
  url: string;
  bootstrapPrompt: string;
  payloadTemplateJson?: string;
  workspaceStrategyType?: string;
  workspaceBaseRef?: string;
  workspaceBranchTemplate?: string;
  worktreeParentDir?: string;
  runtimeServicesJson?: string;
  maxTurnsPerRun: number;
  heartbeatEnabled: boolean;
  intervalSec: number;
  /** Arbitrary key-value pairs populated by schema-driven config fields. */
  adapterSchemaValues?: Record<string, unknown>;
}
