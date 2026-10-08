import { createHash, randomBytes } from "node:crypto";
import type { RunnerE2EResult } from "./types.js";

export const connectionCheckpoints = ["target", "connection_created", "connection_reloaded", "agent_created", "binding", "setup_probe", "first_run", "artifact", "tool_receipt", "followup", "visible_result"] as const;
export type ConnectionCheckpoint = typeof connectionCheckpoints[number];
export const connectionRunSignals = ["provider_overloaded", "provider_quota", "missing_file_conversion", "unsupported_session_configuration", "command_substitution_denied"] as const;
export const connectionSetupCategories = ["authentication_required", "model_unavailable", "missing_dependency", "timeout", "native_protocol", "provider_unavailable", "unclassified"] as const;
export const connectionSetupDependencies = ["paperclip-runnerd", "codex", "opencode", "acpx", "claude", "grok", "cursor", "node"] as const;
export const connectionSetupHttpStatuses = [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504] as const;
export interface ConnectionSetupDiagnostic {
  boundary: "runtime_preparation" | "hello_probe";
  category: typeof connectionSetupCategories[number];
  httpStatus?: typeof connectionSetupHttpStatuses[number];
  dependency?: typeof connectionSetupDependencies[number];
  inputTruncated: boolean;
}
export interface ConnectionRunDiagnostic {
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out" | "unknown";
  signals: Array<typeof connectionRunSignals[number]>;
  logAvailable: boolean;
}
export interface ConnectionEvidence {
  version: 1;
  outcome: "running" | "passed" | "failed" | "awaiting_user" | "missing_credential" | "blocked_target";
  phase: string;
  assisted: boolean;
  authFreshness: "signed-in" | "signed-out";
  target: { mode: "managed-local" | "attach"; origin: string; commit: string | null; deploymentMode: string | null };
  entry: "apps" | "agent";
  method: string;
  checkpoints: Partial<Record<ConnectionCheckpoint, boolean>>;
  waits: Array<{ kind: "board_login" | "provider_login"; startedAt: string; finishedAt?: string }>;
  connectionId?: string;
  agentId?: string;
  companyId?: string;
  artifactSha256?: string;
  model?: string;
  selection?: { harness: string; runnerChoice: "auto" | "legacy"; adapterType: string };
  inputTransport?: "prompt_base64";
  setupChecks?: Array<{ code: string; level: "info" | "warn" | "error"; diagnostic?: ConnectionSetupDiagnostic }>;
  creationFailure?: { status: number; code: "ai_connection_api_key_rejected" | "ai_connection_verification_failed" | "connection_request_rejected" };
  cleanupRetained?: boolean;
  companyArchived?: boolean;
  artifactChecks?: Array<{ filename: string; runId: string; sha256: string; fields: Record<string, boolean>; exactFields: boolean }>;
  runDiagnostics?: ConnectionRunDiagnostic[];
}

/** Project terminal errors to closed diagnostic codes; never retain messages or reasoning. */
export function connectionRunDiagnostic(run: Record<string, any>, log?: unknown): ConnectionRunDiagnostic {
  const signals = new Set<typeof connectionRunSignals[number]>();
  const detect = (text: unknown) => {
    if (typeof text !== "string") return;
    if (/"code"\s*:\s*503\b|\bHTTP\s*503\b/i.test(text) && /overloaded|high demand/i.test(text)) signals.add("provider_overloaded");
    if (/"code"\s*:\s*429\b|\bHTTP\s*429\b|\bRESOURCE_EXHAUSTED\b|\bTerminalQuotaError\b/.test(text)) signals.add("provider_quota");
    if (/Error checking existing file: (?:Resource not found|Internal error)/.test(text)) signals.add("missing_file_conversion");
    if (/set_config_option/.test(text) && /[Mm]ethod not found|-32601/.test(text)) signals.add("unsupported_session_configuration");
    if (/Blocked: command substitution detected/.test(text)) signals.add("command_substitution_denied");
  };
  detect(run.error);
  detect(run.stderrExcerpt);
  const content = log && typeof log === "object" && typeof (log as Record<string, unknown>).content === "string"
    ? (log as { content: string }).content : undefined;
  if (content !== undefined) {
    let inner = "";
    for (const line of content.split("\n")) {
      try { const row = JSON.parse(line); if (typeof row.chunk === "string") inner += row.chunk; }
      catch { /* Non-JSON application lines do not classify provider failures. */ }
    }
    for (const line of inner.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.type === "acpx.error") { detect(row.message); detect(row.childStderrTail); }
        if (row.type === "acpx.tool_call" && row.status === "failed") detect(row.text);
      } catch { /* Model text, partial records, and raw output are not retained. */ }
    }
  }
  const statuses = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
  return { runId: run.id, status: statuses.includes(run.status) ? run.status : "unknown", signals: [...signals], logAvailable: content !== undefined };
}

export function gradeConnectionEvidence(evidence: ConnectionEvidence) {
  return connectionCheckpoints.map(id => ({ matcher: { kind: "json_path" as const, path: `providerConnection.checkpoints.${id}`, expected: true }, passed: evidence.checkpoints[id] === true, detail: `${id}: ${evidence.checkpoints[id] === true ? "verified" : "not verified"}` }));
}

/** Closed clues from bounded native errors; never retain text or change grading. */
function nativeSetupDiagnostic(code: string, message: unknown): ConnectionSetupDiagnostic | undefined {
  const hello = /^(?:codex|claude|opencode|grok|cursor)_hello_probe_(?:failed|auth_required|timeout)$/.test(code);
  if (!hello && !["paperclip_runner_runtime_unavailable", "acpx_runtime_unavailable"].includes(code)) return;
  const text = typeof message === "string" ? message.slice(0, 2_000) : "";
  const status = text.match(/\b(?:HTTP(?:\/[12](?:\.[01])?)?\s+|status(?:\s+code)?[ :=]+)(400|401|403|404|408|409|422|429|500|502|503|504)\b/i);
  const httpStatus = status ? Number(status[1]) as ConnectionSetupDiagnostic["httpStatus"] : undefined;
  const missing = /\b(?:ENOENT|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|(?:command|executable|binary|module|package)\b.{0,100}\b(?:not found|missing|unavailable)|cannot find (?:module|package)/i.test(text);
  const category: ConnectionSetupDiagnostic["category"] = code.endsWith("_auth_required") || httpStatus === 401 || httpStatus === 403 || /invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in/i.test(text)
    ? "authentication_required"
    : /(?:model|provider\/model)\b.{0,120}\b(?:not found|unavailable|not available|unsupported|invalid|does not exist)|\b(?:invalid|unknown|unsupported) model\b|\b(?:ModelNotFoundError|ProviderModelNotFoundError)\b/i.test(text) ? "model_unavailable"
    : missing ? "missing_dependency"
    : code.endsWith("_timeout") || httpStatus === 408 || httpStatus === 504 || /\btimed out\b|\btimeout\b/i.test(text) ? "timeout"
    : /\b(?:protocol|JSON[- ]?RPC)\b.{0,100}\b(?:error|invalid|failed)|\bmethod not found\b|\binitialize\b.{0,100}\b(?:rejected|failed)|\bunexpected (?:native )?event\b/i.test(text) ? "native_protocol"
    : [429, 500, 502, 503].includes(httpStatus ?? 0) || /\b(?:ECONNREFUSED|ENOTFOUND|ECONNRESET)\b|\b(?:overloaded|rate limit(?:ed)?|quota exceeded)\b/i.test(text) ? "provider_unavailable"
    : "unclassified";
  const dependency = missing ? connectionSetupDependencies.find(name => new RegExp(`\\b${name}\\b`, "i").test(text)) : undefined;
  return { boundary: hello ? "hello_probe" : "runtime_preparation", category, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(dependency ? { dependency } : {}), inputTruncated: typeof message === "string" && message.length > 2_000 };
}

/** Retain check codes and closed failed-native diagnostics, never messages/hints/output. */
export function connectionProbeChecks(value: unknown): NonNullable<ConnectionEvidence["setupChecks"]> {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).checks)) return [];
  const nativeFailure = (value as Record<string, unknown>).adapterType === "paperclip_runner" && (value as Record<string, unknown>).status === "fail";
  return ((value as { checks: unknown[] }).checks).slice(0, 50).flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const { code, level } = entry as Record<string, unknown>;
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,95}$/.test(code) || !["info", "warn", "error"].includes(String(level))) return [];
    const diagnostic = nativeFailure && level === "error" ? nativeSetupDiagnostic(code, (entry as Record<string, unknown>).message) : undefined;
    return [{ code, level: level as "info" | "warn" | "error", ...(diagnostic ? { diagnostic } : {}) }];
  });
}

export function connectionEvidencePasses(evidence: ConnectionEvidence) {
  return evidence.outcome === "passed" && Boolean(evidence.target.commit) && gradeConnectionEvidence(evidence).every(check => check.passed);
}

export function isBlockedConnectionResult(result: RunnerE2EResult) {
  return Boolean(result.providerConnection && ["awaiting_user", "missing_credential", "blocked_target"].includes(result.providerConnection.outcome));
}

export function createConnectionProof() {
  const nonce = randomBytes(12).toString("hex");
  const values = Array.from({ length: 7 }, () => randomBytes(2).readUInt16BE());
  const input = `${JSON.stringify({ nonce, values })}\n`;
  const expected = { nonce, count: values.length, total: values.reduce((sum, n) => sum + n, 0), sha256: createHash("sha256").update(input).digest("hex") };
  const followup = { nonce, minimum: Math.min(...values), maximum: Math.max(...values), total: expected.total };
  return { input, expected, followup };
}

export function verifyConnectionArtifact(bytes: Buffer, expected: Record<string, unknown>) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([key, entry]) => value[key] === entry);
  } catch { return false; }
}

/** Only durable run attribution is accepted; assistant text cannot provide it. */
export function verifyConnectionRun(run: Record<string, any>, expected: { agentId: string; connectionId: string; method: string; runtimeMode: string; environmentId: string }) {
  const connection = run.contextSnapshot?.aiConnection;
  return run.status === "succeeded" && run.agentId === expected.agentId && run.runtimeMode === expected.runtimeMode &&
    connection?.connectionId === expected.connectionId && connection?.method === expected.method &&
    run.contextSnapshot?.paperclipEnvironment?.id === expected.environmentId;
}

/** Wait for scheduled repairs to settle, then select the run that actually delivered the file. */
export function completedConnectionArtifactRun(
  runs: Record<string, any>[],
  attachments: Record<string, any>[],
  filename: string,
  expected: Parameters<typeof verifyConnectionRun>[1],
) {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
  if (runs.some(run => !terminal.includes(run.status))) return undefined;
  return runs.find(run => verifyConnectionRun(run, expected) && attachments.some(attachment =>
    attachment.originalFilename === filename && attachment.createdByAgentId === expected.agentId && attachment.originatingRunId === run.id));
}
