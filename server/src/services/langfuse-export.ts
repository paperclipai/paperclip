import { createHash } from "node:crypto";
import { logger } from "../middleware/logger.js";
import type { UsageSummary } from "../adapters/index.js";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_TRACE_NAME = "paperclip.heartbeat_run";

function parseBooleanEnv(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isLangfuseEnabled() {
  return parseBooleanEnv(process.env.PAPERCLIP_LANGFUSE_ENABLED);
}

function normalizeHost(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/$/, "");
  } catch {
    // tolerate scheme-less inputs like "localhost:3000"
    try {
      const url = new URL(`http://${trimmed}`);
      return url.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }
}

function toIsoString(value: unknown) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function safeShortString(value: unknown, maxChars: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeLangfuseEnvironment(value: unknown) {
  const raw = safeShortString(value, 40);
  if (!raw) return "local";

  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) return "local";
  if (normalized.startsWith("langfuse")) return "local";
  return normalized;
}

function deriveUuidV4(seed: string) {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // RFC 4122 version 4 + variant 1
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildAuthHeader(publicKey: string, secretKey: string) {
  const token = Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function parseTimeoutMs(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type LangfuseHeartbeatRunExportInput = {
  companyId?: string | null;
  run?: {
    id?: string | null;
    agentId?: string | null;
    status?: string | null;
    startedAt?: Date | string | null;
    createdAt?: Date | string | null;
    finishedAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } | null;
  agent?: {
    id?: string | null;
    name?: string | null;
    adapterType?: string | null;
  } | null;
  issue?: {
    id?: string | null;
    identifier?: string | null;
    title?: string | null;
  } | null;
  adapterResult?: {
    provider?: string | null;
    model?: string | null;
    billingType?: string | null;
    costUsd?: number | string | null;
    exitCode?: number | null;
  } | null;
  usage?: UsageSummary | null;
  promptVersion?: string | null;
};

export async function maybeExportHeartbeatRunToLangfuse(input: LangfuseHeartbeatRunExportInput) {
  try {
    const enabled = isLangfuseEnabled();
    if (!enabled) return;

    const host =
      normalizeHost(process.env.LANGFUSE_HOST) ??
      normalizeHost(process.env.LANGFUSE_BASE_URL) ??
      normalizeHost(process.env.LANGFUSE_URL);
    const publicKey = typeof process.env.LANGFUSE_PUBLIC_KEY === "string" ? process.env.LANGFUSE_PUBLIC_KEY.trim() : "";
    const secretKey = typeof process.env.LANGFUSE_SECRET_KEY === "string" ? process.env.LANGFUSE_SECRET_KEY.trim() : "";
    if (!host || !publicKey || !secretKey) return;

    const runId = input?.run?.id;
    if (typeof runId !== "string" || !runId) return;

    const issueId = input?.issue?.id ?? null;
    // Keep this exporter low-risk: only export issue-scoped runs.
    if (typeof issueId !== "string" || !issueId) return;

    const agentId = input?.agent?.id ?? input?.run?.agentId ?? null;
    const agentName = safeShortString(input?.agent?.name, 120);
    const adapterType = safeShortString(input?.agent?.adapterType, 80);
    const issueIdentifier = safeShortString(input?.issue?.identifier, 40);
    const issueTitle = safeShortString(input?.issue?.title, 200);
    const status = safeShortString(input?.run?.status, 40);

    const startTime = toIsoString(input?.run?.startedAt ?? input?.run?.createdAt);
    const endTime = toIsoString(input?.run?.finishedAt ?? input?.run?.updatedAt);
    const now = new Date().toISOString();

    const generationId = deriveUuidV4(`${runId}:generation:v1`);
    const traceEventId = deriveUuidV4(`${runId}:trace-create:v1`);
    const generationEventId = deriveUuidV4(`${runId}:generation-create:v1`);
    const scoreId = deriveUuidV4(`${runId}:score:v1`);
    const scoreEventId = deriveUuidV4(`${runId}:score-create:v1`);

    const provider = safeShortString(input?.adapterResult?.provider, 80);
    const model = safeShortString(input?.adapterResult?.model, 120);
    const billingType = safeShortString(input?.adapterResult?.billingType, 40);

    const inputTokens = normalizeNumber(input?.usage?.inputTokens) ?? 0;
    const cachedInputTokens = normalizeNumber(input?.usage?.cachedInputTokens) ?? 0;
    const outputTokens = normalizeNumber(input?.usage?.outputTokens) ?? 0;
    const costUsd = normalizeNumber(input?.adapterResult?.costUsd) ?? null;

    const traceBody = {
      id: runId,
      timestamp: startTime,
      name: DEFAULT_TRACE_NAME,
      userId: typeof agentId === "string" ? agentId : null,
      sessionId: issueId,
      environment: normalizeLangfuseEnvironment(process.env.PAPERCLIP_LANGFUSE_ENVIRONMENT),
      version: safeShortString(input?.promptVersion, 120) ?? null,
      tags: ["paperclip", "heartbeat", ...(adapterType ? [adapterType] : []), ...(issueIdentifier ? [issueIdentifier] : [])],
      metadata: {
        paperclip: {
          companyId: input?.companyId ?? null,
          runId,
          status,
          agentId,
          agentName,
          adapterType,
          issueId,
          issueIdentifier,
          issueTitle,
        },
      },
    };

    const usageDetails = {
      input: inputTokens,
      output: outputTokens,
      cache_read_input_tokens: cachedInputTokens,
    };

    const generationBody = {
      traceId: runId,
      id: generationId,
      name: "paperclip.run",
      startTime,
      endTime,
      model: model ?? null,
      version: safeShortString(input?.promptVersion, 120) ?? null,
      promptName: agentName ? `paperclip.agent:${agentName}` : null,
      usageDetails,
      // Langfuse ingestion currently drops generation observations when costDetails is null/omitted.
      // Prefer a safe default so token usage always shows up in the UI.
      costDetails: { total: costUsd ?? 0 },
      metadata: {
        paperclip: {
          provider,
          billingType,
          ...(typeof input?.adapterResult?.exitCode === "number" ? { exitCode: input.adapterResult.exitCode } : {}),
        },
      },
    };

    const scoreBody = {
      id: scoreId,
      traceId: runId,
      observationId: generationId,
      name: "paperclip.outcome",
      value: status === "succeeded" ? 1 : 0,
      comment: status ? `paperclip run status: ${status}` : null,
      metadata: {
        paperclip: {
          status,
        },
      },
    };

    const payload = {
      batch: [
        { id: traceEventId, timestamp: now, type: "trace-create", body: traceBody },
        { id: generationEventId, timestamp: now, type: "generation-create", body: generationBody },
        { id: scoreEventId, timestamp: now, type: "score-create", body: scoreBody },
      ],
    };

    const endpoint = `${host}/api/public/ingestion`;
    const timeoutMs = parseTimeoutMs(process.env.PAPERCLIP_LANGFUSE_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: buildAuthHeader(publicKey, secretKey),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, statusText: response.statusText, runId, issueId },
          "langfuse export failed",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn({ err }, "langfuse export crashed");
  }
}
