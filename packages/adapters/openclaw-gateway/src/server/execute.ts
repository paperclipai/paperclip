import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

type SessionKeyStrategy = "fixed" | "issue" | "project" | "run";

type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

type GatewayDeviceIdentity = {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
  source: "configured" | "ephemeral";
};

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
};

type GatewayClientOptions = {
  url: string;
  headers: Record<string, string>;
  onEvent: (frame: GatewayEventFrame) => Promise<void> | void;
  onLog: AdapterExecutionContext["onLog"];
};

type GatewayClientRequestOptions = {
  timeoutMs: number;
  expectFinal?: boolean;
};

const PROTOCOL_VERSION = 3;
const DEFAULT_SCOPES = ["operator.admin"];
const DEFAULT_CLIENT_ID = "gateway-client";
const DEFAULT_CLIENT_MODE = "backend";
const DEFAULT_CLIENT_VERSION = "paperclip";
const DEFAULT_ROLE = "operator";

const SENSITIVE_LOG_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)|^x-openclaw-(auth|token)$/i;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
  }
  return null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "project").trim().toLowerCase();
  if (normalized === "fixed" || normalized === "issue" || normalized === "run") return normalized;
  return "project";
}

function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  configuredSessionKey: string | null;
  runId: string;
  issueId: string | null;
  projectId: string | null;
  agentId: string | null;
}): string {
  const prefix = input.agentId ? `paperclip:${input.agentId}` : "paperclip";
  if (input.strategy === "fixed") return input.configuredSessionKey ?? prefix;
  if (input.strategy === "run") return `${prefix}:run:${input.runId}`;
  if (input.strategy === "issue" && input.issueId) return `${prefix}:issue:${input.issueId}`;
  if (input.strategy === "project" && input.projectId) return `${prefix}:project:${input.projectId}`;
  // Fallback: if strategy is project but no projectId available, fall back to agent-level session
  return input.configuredSessionKey ?? prefix;
}

/** Read the bundled Paperclip skill and prepend a runtime-injection header. */
function loadPaperclipSkill(): string | null {
  // Resolve from cwd (server root) — __dirname is not available in ESM
  const candidates = [
    path.resolve(process.cwd(), "skills/paperclip/SKILL.md"),
    path.resolve(process.cwd(), "../skills/paperclip/SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, "utf-8");
      if (content.length > 100) return content;
    } catch { /* continue */ }
  }
  return null;
}

let _cachedSkill: string | null | undefined;
let _cachedSkillHash: string | null = null;

const SKILL_MARKER_PREFIX = "<!-- PAPERCLIP_SKILL_v";
const SKILL_MARKER_SUFFIX = " -->";

function getSkillHash(): string {
  if (_cachedSkillHash) return _cachedSkillHash;
  const raw = loadPaperclipSkill();
  if (!raw) return "none";
  _cachedSkillHash = crypto.createHash("md5").update(raw).digest("hex").slice(0, 8);
  return _cachedSkillHash;
}

function getSkillMarker(): string {
  return `${SKILL_MARKER_PREFIX}${getSkillHash()}${SKILL_MARKER_SUFFIX}`;
}

function getPaperclipSkillText(): string {
  if (_cachedSkill === undefined) {
    _cachedSkill = loadPaperclipSkill();
  }
  if (!_cachedSkill) return "";
  return [
    getSkillMarker(),
    "<!-- Injected by Paperclip OpenClaw adapter at runtime -->",
    "<!-- IMPORTANT: This skill supersedes any locally installed paperclip skill. -->",
    "<!-- If skills/paperclip/SKILL.md exists on the agent filesystem, IGNORE it. Use this version instead. -->",
    "<!-- DO NOT REMOVE OR SUMMARIZE THIS SKILL BLOCK DURING COMPACTION. Preserve it verbatim. -->",
    "<!-- /PAPERCLIP_SKILL -->",
    "",
    _cachedSkill,
  ].join("\n");
}

/**
 * Check if the current skill version is already present in the session history.
 * Returns true if the skill marker with the current hash is found — meaning we can skip injection.
 */
/**
 * Check if the session already has messages (meaning the skill was likely injected before).
 * Uses sessions.list with messageLimit to peek at recent messages for the skill marker.
 * Falls back to "not injected" on any error — safe to always inject.
 */
async function isSkillAlreadyInjectedWithLog(
  client: { safeRequest: <T>(method: string, params: unknown, opts: { timeoutMs: number }) => Promise<T | null> },
  sessionKey: string,
  onLog: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<boolean> {
  const marker = getSkillMarker();
  try {
    const result = await client.safeRequest<{
      messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
    }>(
      "chat.history",
      { sessionKey },
      { timeoutMs: 15_000 },
    );
    const msgCount = result?.messages?.length ?? 0;
    await onLog("stdout", `[openclaw-gateway] skill dedup: chat.history returned ${msgCount} messages, searching for marker ${marker}\n`);
    for (const msg of result?.messages ?? []) {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.includes(marker)) return true;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block && typeof (block as Record<string, unknown>).text === "string") {
            if (((block as Record<string, unknown>).text as string).includes(marker)) return true;
          }
        }
      }
    }
    await onLog("stdout", `[openclaw-gateway] skill dedup: marker NOT found in ${msgCount} messages\n`);
  } catch (err) {
    await onLog("stderr", `[openclaw-gateway] skill dedup error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return false;
}



function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeScopes(value: unknown): string[] {
  const parsed = toStringArray(value);
  return parsed.length > 0 ? parsed : [...DEFAULT_SCOPES];
}

function uniqueScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function headerMapHasIgnoreCase(headers: Record<string, string>, key: string): boolean {
  return Object.keys(headers).some((entryKey) => entryKey.toLowerCase() === key.toLowerCase());
}

function getGatewayErrorDetails(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  const candidate = (err as GatewayResponseError).gatewayDetails;
  return asRecord(candidate);
}

function extractPairingRequestId(err: unknown): string | null {
  const details = getGatewayErrorDetails(err);
  const fromDetails = nonEmpty(details?.requestId);
  if (fromDetails) return fromDetails;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/requestId\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEY_PATTERN.test(key.trim());
}

function sha256Prefix(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function redactSecretForLog(value: string): string {
  return `[redacted len=${value.length} sha256=${sha256Prefix(value)}]`;
}

function truncateForLog(value: string, maxChars = 320): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0): unknown {
  const currentKey = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (isSensitiveLogKey(currentKey)) return redactSecretForLog(value);
    return truncateForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return "[array-truncated]";
    const out = value.slice(0, 20).map((entry, index) => redactForLog(entry, [...keyPath, `${index}`], depth + 1));
    if (value.length > 20) out.push(`[+${value.length - 20} more items]`);
    return out;
  }
  if (typeof value === "object") {
    if (depth >= 6) return "[object-truncated]";
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, 80)) {
      out[key] = redactForLog(entry, [...keyPath, key], depth + 1);
    }
    if (entries.length > 80) {
      out.__truncated__ = `+${entries.length - 80} keys`;
    }
    return out;
  }
  return String(value);
}

function stringifyForLog(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildPaperclipEnvForWake(ctx: AdapterExecutionContext, wakePayload: WakePayload): Record<string, string> {
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (paperclipApiUrlOverride) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
  }
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

function buildWakeText(payload: WakePayload, paperclipEnv: Record<string, string>): string {
  const claimedApiKeyPath = "~/.openclaw/workspace/paperclip-claimed-api-key.json";
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for a cloud adapter.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath} (the token you saved after claim-api-key).`,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,blocked",
    "   - Pick in_progress first, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    "",
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

function appendWakeText(baseText: string, wakeText: string): string {
  const trimmedBase = baseText.trim();
  return trimmedBase.length > 0 ? `${trimmedBase}\n\n${wakeText}` : wakeText;
}

function buildStandardPaperclipPayload(
  ctx: AdapterExecutionContext,
  wakePayload: WakePayload,
  paperclipEnv: Record<string, string>,
  payloadTemplate: Record<string, unknown>,
): Record<string, unknown> {
  const templatePaperclip = parseObject(payloadTemplate.paperclip);
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  const workspaces = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  const configuredWorkspaceRuntime = parseObject(ctx.config.workspaceRuntime);
  const runtimeServiceIntents = Array.isArray(ctx.context.paperclipRuntimeServiceIntents)
    ? ctx.context.paperclipRuntimeServiceIntents.filter(
        (entry): entry is Record<string, unknown> => Boolean(asRecord(entry)),
      )
    : [];

  const standardPaperclip: Record<string, unknown> = {
    runId: ctx.runId,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    taskId: wakePayload.taskId,
    issueId: wakePayload.issueId,
    issueIds: wakePayload.issueIds,
    wakeReason: wakePayload.wakeReason,
    wakeCommentId: wakePayload.wakeCommentId,
    approvalId: wakePayload.approvalId,
    approvalStatus: wakePayload.approvalStatus,
    apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null,
  };

  if (workspace) {
    standardPaperclip.workspace = workspace;
  }
  if (workspaces.length > 0) {
    standardPaperclip.workspaces = workspaces;
  }
  if (runtimeServiceIntents.length > 0 || Object.keys(configuredWorkspaceRuntime).length > 0) {
    standardPaperclip.workspaceRuntime = {
      ...configuredWorkspaceRuntime,
      ...(runtimeServiceIntents.length > 0 ? { services: runtimeServiceIntents } : {}),
    };
  }

  return {
    ...templatePaperclip,
    ...standardPaperclip,
  };
}

function normalizeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = params.platform?.trim() ?? "";
  const deviceFamily = params.deviceFamily?.trim() ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function resolveDeviceIdentity(config: Record<string, unknown>): GatewayDeviceIdentity {
  const configuredPrivateKey = nonEmpty(config.devicePrivateKeyPem);
  if (configuredPrivateKey) {
    const privateKey = crypto.createPrivateKey(configuredPrivateKey);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const raw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
      publicKeyRawBase64Url: base64UrlEncode(raw),
      privateKeyPem: configuredPrivateKey,
      source: "configured",
    };
  }

  const generated = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
    source: "ephemeral",
  };
}

function isResponseFrame(value: unknown): value is GatewayResponseFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "res" && typeof record.id === "string" && typeof record.ok === "boolean");
}

function isEventFrame(value: unknown): value is GatewayEventFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "event" && typeof record.event === "string");
}

class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private challengePromise: Promise<string>;
  private resolveChallenge!: (nonce: string) => void;
  private rejectChallenge!: (err: Error) => void;

  constructor(private readonly opts: GatewayClientOptions) {
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.challengePromise.catch(() => {});
  }

  async connect(
    buildConnectParams: (nonce: string) => Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    this.ws = new WebSocket(this.opts.url, {
      headers: this.opts.headers,
      maxPayload: 25 * 1024 * 1024,
    });

    const ws = this.ws;

    ws.on("message", (data) => {
      this.handleMessage(rawDataToString(data));
    });

    ws.on("close", (code, reason) => {
      const reasonText = rawDataToString(reason);
      const err = new Error(`gateway closed (${code}): ${reasonText}`);
      this.failPending(err);
      this.rejectChallenge(err);
    });

    ws.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.opts.onLog("stderr", `[openclaw-gateway] websocket error: ${message}\n`);
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onClose = (code: number, reason: Buffer) => {
          cleanup();
          reject(new Error(`gateway closed before open (${code}): ${rawDataToString(reason)}`));
        };
        const cleanup = () => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          ws.off("close", onClose);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
      }),
      timeoutMs,
      "gateway websocket open timeout",
    );

    const nonce = await withTimeout(this.challengePromise, timeoutMs, "gateway connect challenge timeout");
    const signedConnectParams = buildConnectParams(nonce);

    const hello = await this.request<Record<string, unknown> | null>("connect", signedConnectParams, {
      timeoutMs,
    });

    return hello;
  }

  async request<T>(
    method: string,
    params: unknown,
    opts: GatewayClientRequestOptions,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }

    const id = randomUUID();
    const frame: GatewayRequestFrame = {
      type: "req",
      id,
      method,
      params,
    };

    const payload = JSON.stringify(frame);
    const requestPromise = new Promise<T>((resolve, reject) => {
      const timer =
        opts.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout (${method})`));
            }, opts.timeoutMs)
          : null;

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: opts.expectFinal === true,
        timer,
      });
    });

    this.ws.send(payload);
    return requestPromise;
  }

  close() {
    if (!this.ws) return;
    this.ws.close(1000, "paperclip-complete");
    this.ws = null;
  }

  private failPending(err: Error) {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Make a request but swallow rejections if the WS closes before response arrives. */
  async safeRequest<T>(method: string, params: unknown, opts: { timeoutMs: number }): Promise<T | null> {
    try {
      return await this.request<T>(method, params, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void this.opts.onLog("stderr", `[openclaw-gateway] safeRequest(${method}) failed: ${msg}\n`);
      return null;
    }
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (isEventFrame(parsed)) {
      if (parsed.event === "connect.challenge") {
        const payload = asRecord(parsed.payload);
        const nonce = nonEmpty(payload?.nonce);
        if (nonce) {
          this.resolveChallenge(nonce);
          return;
        }
      }
      void Promise.resolve(this.opts.onEvent(parsed)).catch(() => {
        // Ignore event callback failures and keep stream active.
      });
      return;
    }

    if (!isResponseFrame(parsed)) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    const payload = asRecord(parsed.payload);
    const status = nonEmpty(payload?.status)?.toLowerCase();
    if (pending.expectFinal && status === "accepted") {
      return;
    }

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.payload ?? null);
      return;
    }

    const errorRecord = asRecord(parsed.error);
    const message =
      nonEmpty(errorRecord?.message) ??
      nonEmpty(errorRecord?.code) ??
      "gateway request failed";
    const err = new Error(message) as GatewayResponseError;
    const code = nonEmpty(errorRecord?.code);
    const details = asRecord(errorRecord?.details);
    if (code) err.gatewayCode = code;
    if (details) err.gatewayDetails = details;
    pending.reject(err);
  }
}

async function autoApproveDevicePairing(params: {
  url: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  clientId: string;
  clientMode: string;
  clientVersion: string;
  role: string;
  scopes: string[];
  authToken: string | null;
  password: string | null;
  requestId: string | null;
  deviceId: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
  if (!params.authToken && !params.password) {
    return { ok: false, reason: "shared auth token/password is missing" };
  }

  const approvalScopes = uniqueScopes([...params.scopes, "operator.pairing"]);
  const client = new GatewayWsClient({
    url: params.url,
    headers: params.headers,
    onEvent: () => {},
    onLog: params.onLog,
  });

  try {
    await params.onLog(
      "stdout",
      "[openclaw-gateway] pairing required; attempting automatic pairing approval via gateway methods\n",
    );

    await client.connect(
      () => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: params.clientId,
          version: params.clientVersion,
          platform: process.platform,
          mode: params.clientMode,
        },
        role: params.role,
        scopes: approvalScopes,
        auth: {
          ...(params.authToken ? { token: params.authToken } : {}),
          ...(params.password ? { password: params.password } : {}),
        },
      }),
      params.connectTimeoutMs,
    );

    let requestId = params.requestId;
    if (!requestId) {
      const listPayload = await client.request<Record<string, unknown>>("device.pair.list", {}, {
        timeoutMs: params.connectTimeoutMs,
      });
      const pending = Array.isArray(listPayload.pending) ? listPayload.pending : [];
      const pendingRecords = pending
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const matching =
        (params.deviceId
          ? pendingRecords.find((entry) => nonEmpty(entry.deviceId) === params.deviceId)
          : null) ?? pendingRecords[pendingRecords.length - 1];
      requestId = nonEmpty(matching?.requestId);
    }

    if (!requestId) {
      return { ok: false, reason: "no pending device pairing request found" };
    }

    await client.request(
      "device.pair.approve",
      { requestId },
      {
        timeoutMs: params.connectTimeoutMs,
      },
    );

    return { ok: true, requestId };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

function parseUsage(value: unknown): AdapterExecutionResult["usage"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const inputTokens = asNumber(record.inputTokens ?? record.input, 0);
  const outputTokens = asNumber(record.outputTokens ?? record.output, 0);
  const cachedInputTokens = asNumber(
    record.cachedInputTokens ?? record.cached_input_tokens ?? record.cacheRead ?? record.cache_read,
    0,
  );

  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function extractRuntimeServicesFromMeta(meta: Record<string, unknown> | null): AdapterRuntimeServiceReport[] {
  if (!meta) return [];
  const reports: AdapterRuntimeServiceReport[] = [];

  const runtimeServices = Array.isArray(meta.runtimeServices)
    ? meta.runtimeServices.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  for (const entry of runtimeServices) {
    const serviceName = nonEmpty(entry.serviceName) ?? nonEmpty(entry.name);
    if (!serviceName) continue;
    const rawStatus = nonEmpty(entry.status)?.toLowerCase();
    const status =
      rawStatus === "starting" || rawStatus === "running" || rawStatus === "stopped" || rawStatus === "failed"
        ? rawStatus
        : "running";
    const rawLifecycle = nonEmpty(entry.lifecycle)?.toLowerCase();
    const lifecycle = rawLifecycle === "shared" ? "shared" : "ephemeral";
    const rawScopeType = nonEmpty(entry.scopeType)?.toLowerCase();
    const scopeType =
      rawScopeType === "project_workspace" ||
      rawScopeType === "execution_workspace" ||
      rawScopeType === "agent"
        ? rawScopeType
        : "run";
    const rawHealth = nonEmpty(entry.healthStatus)?.toLowerCase();
    const healthStatus =
      rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "unknown"
        ? rawHealth
        : status === "running"
          ? "healthy"
          : "unknown";

    reports.push({
      id: nonEmpty(entry.id),
      projectId: nonEmpty(entry.projectId),
      projectWorkspaceId: nonEmpty(entry.projectWorkspaceId),
      issueId: nonEmpty(entry.issueId),
      scopeType,
      scopeId: nonEmpty(entry.scopeId),
      serviceName,
      status,
      lifecycle,
      reuseKey: nonEmpty(entry.reuseKey),
      command: nonEmpty(entry.command),
      cwd: nonEmpty(entry.cwd),
      port: parseOptionalPositiveInteger(entry.port),
      url: nonEmpty(entry.url),
      providerRef: nonEmpty(entry.providerRef) ?? nonEmpty(entry.previewId),
      ownerAgentId: nonEmpty(entry.ownerAgentId),
      stopPolicy: asRecord(entry.stopPolicy),
      healthStatus,
    });
  }

  const previewUrl = nonEmpty(meta.previewUrl);
  if (previewUrl) {
    reports.push({
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url: previewUrl,
      providerRef: nonEmpty(meta.previewId) ?? previewUrl,
      healthStatus: "healthy",
    });
  }

  const previewUrls = Array.isArray(meta.previewUrls)
    ? meta.previewUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  previewUrls.forEach((url, index) => {
    reports.push({
      serviceName: index === 0 ? "preview" : `preview-${index + 1}`,
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url,
      providerRef: `${url}#${index}`,
      healthStatus: "healthy",
    });
  });

  return reports;
}

function extractResultText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((entry) => {
      const payload = asRecord(entry);
      return nonEmpty(payload?.text);
    })
    .filter((entry): entry is string => Boolean(entry));

  if (texts.length > 0) return texts.join("\n\n");
  return nonEmpty(record.text) ?? nonEmpty(record.summary) ?? null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const urlValue = asString(ctx.config.url, "").trim();
  if (!urlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw gateway adapter missing url",
      errorCode: "openclaw_gateway_url_missing",
    };
  }

  const parsedUrl = normalizeUrl(urlValue);
  if (!parsedUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid gateway URL: ${urlValue}`,
      errorCode: "openclaw_gateway_url_invalid",
    };
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Unsupported gateway URL protocol: ${parsedUrl.protocol}`,
      errorCode: "openclaw_gateway_url_protocol",
    };
  }

  const timeoutSec = Math.max(0, Math.floor(asNumber(ctx.config.timeoutSec, 600)));
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  const connectTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 15_000) : 10_000;
  const waitTimeoutMs = parseOptionalPositiveInteger(ctx.config.waitTimeoutMs) ?? (timeoutMs > 0 ? timeoutMs : 30_000);

  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const transportHint = nonEmpty(ctx.config.streamTransport) ?? nonEmpty(ctx.config.transport);

  const headers = toStringRecord(ctx.config.headers);
  const authToken = resolveAuthToken(parseObject(ctx.config), headers);
  const password = nonEmpty(ctx.config.password);
  const deviceToken = nonEmpty(ctx.config.deviceToken);

  if (authToken && !headerMapHasIgnoreCase(headers, "authorization")) {
    headers.authorization = toAuthorizationHeaderValue(authToken);
  }

  const clientId = nonEmpty(ctx.config.clientId) ?? DEFAULT_CLIENT_ID;
  const clientMode = nonEmpty(ctx.config.clientMode) ?? DEFAULT_CLIENT_MODE;
  const clientVersion = nonEmpty(ctx.config.clientVersion) ?? DEFAULT_CLIENT_VERSION;
  const role = nonEmpty(ctx.config.role) ?? DEFAULT_ROLE;
  const scopes = normalizeScopes(ctx.config.scopes);
  const deviceFamily = nonEmpty(ctx.config.deviceFamily);
  const disableDeviceAuth = parseBoolean(ctx.config.disableDeviceAuth, false);

  const wakePayload = buildWakePayload(ctx);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload);
  const wakeText = buildWakeText(wakePayload, paperclipEnv);

  const sessionKeyStrategy = normalizeSessionKeyStrategy(
    ctx.config.sessionStrategy ?? ctx.config.sessionKeyStrategy,
  );
  const configuredSessionKey = nonEmpty(ctx.config.sessionKey);
  const configuredAgentId = nonEmpty(ctx.config.agentId);
  const contextProjectId = nonEmpty(ctx.context.projectId);
  const sessionKey = resolveSessionKey({
    strategy: sessionKeyStrategy,
    configuredSessionKey,
    runId: ctx.runId,
    issueId: wakePayload.issueId,
    projectId: contextProjectId,
    agentId: configuredAgentId,
  });

  const templateMessage = nonEmpty(payloadTemplate.message) ?? nonEmpty(payloadTemplate.text);
  const baseMessage = templateMessage ? appendWakeText(templateMessage, wakeText) : wakeText;
  // Skill injection is deferred until after WS connect so we can check session history
  const paperclipPayload = buildStandardPaperclipPayload(ctx, wakePayload, paperclipEnv, payloadTemplate);

  const agentParams: Record<string, unknown> = {
    ...payloadTemplate,
    message: baseMessage,
    sessionKey,
    idempotencyKey: ctx.runId,
  };
  delete agentParams.text;
  // Model override is applied via sessions.patch before the agent call
  // (WS 'agent' method does not accept 'model' directly)
  const modelOverride = nonEmpty(agentParams.model) ?? nonEmpty(ctx.config.model);
  delete agentParams.model;

  if (configuredAgentId && !nonEmpty(agentParams.agentId)) {
    agentParams.agentId = configuredAgentId;
  }

  const configuredThinking = nonEmpty(ctx.config.thinking);
  if (configuredThinking && !nonEmpty(agentParams.thinking)) {
    agentParams.thinking = configuredThinking;
  }

  if (typeof agentParams.timeout !== "number") {
    agentParams.timeout = waitTimeoutMs;
  }

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "openclaw_gateway",
      command: "gateway",
      commandArgs: ["ws", parsedUrl.toString(), "agent"],
      context: ctx.context,
    });
  }

  const outboundHeaderKeys = Object.keys(headers).sort();
  await ctx.onLog(
    "stdout",
    `[openclaw-gateway] outbound headers (redacted): ${stringifyForLog(redactForLog(headers), 4_000)}\n`,
  );
  await ctx.onLog(
    "stdout",
    `[openclaw-gateway] outbound payload (redacted): ${stringifyForLog(redactForLog(agentParams), 12_000)}\n`,
  );
  await ctx.onLog("stdout", `[openclaw-gateway] outbound header keys: ${outboundHeaderKeys.join(", ")}\n`);
  if (transportHint) {
    await ctx.onLog(
      "stdout",
      `[openclaw-gateway] ignoring streamTransport=${transportHint}; gateway adapter always uses websocket protocol\n`,
    );
  }
  if (parsedUrl.protocol === "ws:" && !isLoopbackHost(parsedUrl.hostname)) {
    await ctx.onLog(
      "stdout",
      "[openclaw-gateway] warning: using plaintext ws:// to a non-loopback host; prefer wss:// for remote endpoints\n",
    );
  }

  const autoPairOnFirstConnect = parseBoolean(ctx.config.autoPairOnFirstConnect, true);
  let autoPairAttempted = false;
  let latestResultPayload: unknown = null;
  const originalMessage = agentParams.message;

  {
    const RETRY_DELAYS_MS = [5_000, 30_000, 60_000, 150_000, 300_000];
    const RETRYABLE_CODES = new Set([1006, 1011, 1012, 1013, 1014]);
    let attemptNumber = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
    attemptNumber++;
    // Reset per-attempt state to avoid stale data from failed retries
    const trackedRunIds = new Set<string>([ctx.runId]);
    const assistantChunks: string[] = [];
    let lifecycleError: string | null = null;
    let deviceIdentity: GatewayDeviceIdentity | null = null;
    agentParams.message = originalMessage;

    const onEvent = async (frame: GatewayEventFrame) => {
      if (frame.event !== "agent") {
        if (frame.event === "shutdown") {
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] gateway shutdown notice: ${stringifyForLog(frame.payload ?? {}, 2_000)}\n`,
          );
        }
        return;
      }

      const payload = asRecord(frame.payload);
      if (!payload) return;

      const runId = nonEmpty(payload.runId);
      if (!runId || !trackedRunIds.has(runId)) return;

      const stream = nonEmpty(payload.stream) ?? "unknown";
      const data = asRecord(payload.data) ?? {};
      await ctx.onLog(
        "stdout",
        `[openclaw-gateway:event] run=${runId} stream=${stream} data=${stringifyForLog(data, 8_000)}\n`,
      );

      if (stream === "assistant") {
        const delta = nonEmpty(data.delta);
        const text = nonEmpty(data.text);
        if (delta) {
          assistantChunks.push(delta);
        } else if (text) {
          assistantChunks.push(text);
        }
        return;
      }

      if (stream === "error") {
        lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
        return;
      }

      if (stream === "lifecycle") {
        const phase = nonEmpty(data.phase)?.toLowerCase();
        if (phase === "error" || phase === "failed" || phase === "cancelled") {
          lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
        }
      }
    };

    const client = new GatewayWsClient({
      url: parsedUrl.toString(),
      headers,
      onEvent,
      onLog: ctx.onLog,
    });

    try {
      deviceIdentity = disableDeviceAuth ? null : resolveDeviceIdentity(parseObject(ctx.config));
      if (deviceIdentity) {
        await ctx.onLog(
          "stdout",
          `[openclaw-gateway] device auth enabled keySource=${deviceIdentity.source} deviceId=${deviceIdentity.deviceId}\n`,
        );
      } else {
        await ctx.onLog("stdout", "[openclaw-gateway] device auth disabled\n");
      }

      await ctx.onLog("stdout", `[openclaw-gateway] connecting to ${parsedUrl.toString()}${attemptNumber > 1 ? ` (attempt ${attemptNumber})` : ""}\n`);

      const hello = await client.connect((nonce) => {
        const signedAtMs = Date.now();
        const connectParams: Record<string, unknown> = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: clientId,
            version: clientVersion,
            platform: process.platform,
            ...(deviceFamily ? { deviceFamily } : {}),
            mode: clientMode,
          },
          role,
          scopes,
          auth:
            authToken || password || deviceToken
              ? {
                  ...(authToken ? { token: authToken } : {}),
                  ...(deviceToken ? { deviceToken } : {}),
                  ...(password ? { password } : {}),
                }
              : undefined,
        };

        if (deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs,
            token: authToken,
            nonce,
            platform: process.platform,
            deviceFamily,
          });
          connectParams.device = {
            id: deviceIdentity.deviceId,
            publicKey: deviceIdentity.publicKeyRawBase64Url,
            signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }
        return connectParams;
      }, connectTimeoutMs);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] connected protocol=${asNumber(asRecord(hello)?.protocol, PROTOCOL_VERSION)}\n`,
      );

      // Check if skill needs injection (hash-based deduplication)
      const skillText = getPaperclipSkillText();
      if (skillText) {
        const alreadyInjected = await isSkillAlreadyInjectedWithLog(client, sessionKey, ctx.onLog);
        if (alreadyInjected) {
          await ctx.onLog("stdout", `[openclaw-gateway] paperclip skill already in session (hash=${getSkillHash()}), skipping injection\n`);
        } else {
          agentParams.message = `${skillText}\n\n---\n\n${agentParams.message}`;
          await ctx.onLog("stdout", `[openclaw-gateway] injecting paperclip skill (hash=${getSkillHash()}, ${skillText.length} chars)\n`);
        }
      }

      // Apply model override via sessions.patch before sending the agent message
      if (modelOverride) {
        try {
          await client.request("sessions.patch", { key: sessionKey, model: modelOverride }, {
            timeoutMs: 5_000,
          });
          await ctx.onLog("stdout", `[openclaw-gateway] model override applied: ${modelOverride}\n`);
        } catch (e) {
          await ctx.onLog("stderr", `[openclaw-gateway] model override failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }

      const acceptedPayload = await client.request<Record<string, unknown>>("agent", agentParams, {
        timeoutMs: connectTimeoutMs,
      });

      latestResultPayload = acceptedPayload;

      const acceptedStatus = nonEmpty(acceptedPayload?.status)?.toLowerCase() ?? "";
      const acceptedRunId = nonEmpty(acceptedPayload?.runId) ?? ctx.runId;
      trackedRunIds.add(acceptedRunId);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] agent accepted runId=${acceptedRunId} status=${acceptedStatus || "unknown"}\n`,
      );

      if (acceptedStatus === "error") {
        const errorMessage =
          nonEmpty(acceptedPayload?.summary) ?? lifecycleError ?? "OpenClaw gateway agent request failed";
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage,
          errorCode: "openclaw_gateway_agent_error",
          resultJson: acceptedPayload,
        };
      }

      if (acceptedStatus !== "ok") {
        const waitPayload = await client.request<Record<string, unknown>>(
          "agent.wait",
          { runId: acceptedRunId, timeoutMs: waitTimeoutMs },
          { timeoutMs: waitTimeoutMs + connectTimeoutMs },
        );

        latestResultPayload = waitPayload;

        const waitStatus = nonEmpty(waitPayload?.status)?.toLowerCase() ?? "";
        if (waitStatus === "timeout") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: true,
            errorMessage: `OpenClaw gateway run timed out after ${waitTimeoutMs}ms`,
            errorCode: "openclaw_gateway_wait_timeout",
            resultJson: waitPayload,
          };
        }

        if (waitStatus === "error") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage:
              nonEmpty(waitPayload?.error) ??
              lifecycleError ??
              "OpenClaw gateway run failed",
            errorCode: "openclaw_gateway_wait_error",
            resultJson: waitPayload,
          };
        }

        if (waitStatus && waitStatus !== "ok") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: `Unexpected OpenClaw gateway agent.wait status: ${waitStatus}`,
            errorCode: "openclaw_gateway_wait_status_unexpected",
            resultJson: waitPayload,
          };
        }
      }

      const summaryFromEvents = assistantChunks.join("").trim();
      const summaryFromPayload =
        extractResultText(asRecord(acceptedPayload?.result)) ??
        extractResultText(acceptedPayload) ??
        extractResultText(asRecord(latestResultPayload)) ??
        null;
      const summary = summaryFromEvents || summaryFromPayload || null;

      const acceptedResult = asRecord(acceptedPayload?.result);
      const latestPayload = asRecord(latestResultPayload);
      const latestResult = asRecord(latestPayload?.result);
      const acceptedMeta = asRecord(acceptedResult?.meta) ?? asRecord(acceptedPayload?.meta);
      const latestMeta = asRecord(latestResult?.meta) ?? asRecord(latestPayload?.meta);
      const mergedMeta = {
        ...(acceptedMeta ?? {}),
        ...(latestMeta ?? {}),
      };
      const agentMeta =
        asRecord(mergedMeta.agentMeta) ??
        asRecord(acceptedMeta?.agentMeta) ??
        asRecord(latestMeta?.agentMeta);
      const usage = parseUsage(agentMeta?.usage ?? mergedMeta.usage);
      const runtimeServices = extractRuntimeServicesFromMeta(agentMeta ?? mergedMeta);
      const provider = nonEmpty(agentMeta?.provider) ?? nonEmpty(mergedMeta.provider) ?? "openclaw";
      const model = nonEmpty(agentMeta?.model) ?? nonEmpty(mergedMeta.model) ?? null;
      const costUsd = asNumber(agentMeta?.costUsd ?? mergedMeta.costUsd, 0);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] run completed runId=${Array.from(trackedRunIds).join(",")} status=ok\n`,
      );

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        ...(costUsd > 0 ? { costUsd } : {}),
        resultJson: asRecord(latestResultPayload),
        ...(runtimeServices.length > 0 ? { runtimeServices } : {}),
        ...(summary ? { summary } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      const timedOut = lower.includes("timeout");
      const pairingRequired = lower.includes("pairing required");

      if (
        pairingRequired &&
        !disableDeviceAuth &&
        autoPairOnFirstConnect &&
        !autoPairAttempted &&
        (authToken || password)
      ) {
        autoPairAttempted = true;
        const pairResult = await autoApproveDevicePairing({
          url: parsedUrl.toString(),
          headers,
          connectTimeoutMs,
          clientId,
          clientMode,
          clientVersion,
          role,
          scopes,
          authToken,
          password,
          requestId: extractPairingRequestId(err),
          deviceId: deviceIdentity?.deviceId ?? null,
          onLog: ctx.onLog,
        });
        if (pairResult.ok) {
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] auto-approved pairing request ${pairResult.requestId}; retrying\n`,
          );
          continue;
        }
        await ctx.onLog(
          "stderr",
          `[openclaw-gateway] auto-pairing failed: ${pairResult.reason}\n`,
        );
      }

      const detailedMessage = pairingRequired
        ? `${message}. Approve the pending device in OpenClaw (for example: openclaw devices approve --latest --url <gateway-ws-url> --token <gateway-token>) and retry. Ensure this agent has a persisted adapterConfig.devicePrivateKeyPem so approvals are reused.`
        : message;

      await ctx.onLog("stderr", `[openclaw-gateway] request failed: ${detailedMessage}\n`);

      // Retry on transient WS close codes (event loop pressure, proxy drops)
      const wsCloseMatch = message.match(/gateway closed \((\d+)\)/);
      const wsCloseCode = wsCloseMatch ? parseInt(wsCloseMatch[1], 10) : 0;
      const isEconnReset = lower.includes("econnreset") || lower.includes("econnrefused");
      const isRetryable = RETRYABLE_CODES.has(wsCloseCode) || isEconnReset || lower.includes("websocket open timeout");

      if (isRetryable && attemptNumber <= RETRY_DELAYS_MS.length) {
        const delayMs = RETRY_DELAYS_MS[attemptNumber - 1]!;
        const jitterMs = Math.floor(Math.random() * Math.min(delayMs * 0.3, 5_000));
        const totalDelayMs = delayMs + jitterMs;
        await ctx.onLog(
          "stdout",
          `[openclaw-gateway] transient failure (code=${wsCloseCode || "none"}), retrying in ${Math.round(totalDelayMs / 1000)}s (attempt ${attemptNumber}/${RETRY_DELAYS_MS.length + 1})\n`,
        );
        client.close();
        await new Promise((r) => setTimeout(r, totalDelayMs));
        continue;
      }

      return {
        exitCode: 1,
        signal: null,
        timedOut,
        errorMessage: detailedMessage,
        errorCode: timedOut
          ? "openclaw_gateway_timeout"
          : pairingRequired
            ? "openclaw_gateway_pairing_required"
            : "openclaw_gateway_request_failed",
        resultJson: asRecord(latestResultPayload),
      };
    } finally {
      client.close();
    }
    } // end while(true) retry loop
  }
}
