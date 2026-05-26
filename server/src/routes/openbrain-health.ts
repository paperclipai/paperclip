import { readFile } from "node:fs/promises";
import { Router } from "express";

const DEFAULT_HEALTH_FILE = "/Users/drew/mission-control-pilot/openbrain-health/latest.json";
const SECRET_KEY_PATTERN = /(key|token|secret|password|connection|string|url)/i;

type HealthStatus = "ok" | "degraded" | "down" | "unknown";

type OpenBrainHealthResponse = {
  status: HealthStatus;
  checkedAt: string;
  supabase?: {
    reachable: boolean;
    latencyMs?: number;
  };
  openbrain: {
    dbOk: boolean;
    memoryCount?: number;
    lastCapturedAt?: string;
  };
  embedding?: {
    reachable: boolean;
    provider?: string;
    model?: string;
    dims?: number;
  };
  knowledgeGraph?: {
    enabled: boolean;
  };
  errors?: Array<{
    component: string;
    message: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStatus(value: unknown): HealthStatus {
  return value === "ok" || value === "degraded" || value === "down" || value === "unknown"
    ? value
    : "unknown";
}

function toBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeMessage(value: unknown): string {
  const message = typeof value === "string" ? value : "Health check failed";
  return message
    .replace(/(service[_-]?role|anon|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[REDACTED]")
    .replace(/https?:\/\/[^\s"']*(supabase|db)[^\s"']*/gi, "https://[REDACTED]");
}

function rejectSecretLikeKeys(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLikeKeys(item, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && key !== "checkedAt" && key !== "lastCapturedAt" && key !== "latencyMs") {
      throw new Error(`Secret-like field is not allowed in OpenBrain health response: ${[...path, key].join(".")}`);
    }
    rejectSecretLikeKeys(nested, [...path, key]);
  }
}

function normalizeHealth(raw: unknown): OpenBrainHealthResponse {
  rejectSecretLikeKeys(raw);
  if (!isRecord(raw)) {
    throw new Error("OpenBrain health payload must be an object");
  }

  const openbrain = isRecord(raw.openbrain) ? raw.openbrain : {};
  const supabase = isRecord(raw.supabase) ? raw.supabase : undefined;
  const embedding = isRecord(raw.embedding) ? raw.embedding : undefined;
  const knowledgeGraph = isRecord(raw.knowledgeGraph) ? raw.knowledgeGraph : undefined;
  const errors = Array.isArray(raw.errors)
    ? raw.errors
        .filter(isRecord)
        .map((error) => ({
          component: toString(error.component) ?? "unknown",
          message: sanitizeMessage(error.message),
        }))
    : undefined;

  return {
    status: toStatus(raw.status),
    checkedAt: toString(raw.checkedAt) ?? new Date().toISOString(),
    ...(supabase
      ? {
          supabase: {
            reachable: toBoolean(supabase.reachable),
            ...(toNumber(supabase.latencyMs) !== undefined ? { latencyMs: toNumber(supabase.latencyMs) } : {}),
          },
        }
      : {}),
    openbrain: {
      dbOk: toBoolean(openbrain.dbOk),
      ...(toNumber(openbrain.memoryCount) !== undefined ? { memoryCount: toNumber(openbrain.memoryCount) } : {}),
      ...(toString(openbrain.lastCapturedAt) ? { lastCapturedAt: toString(openbrain.lastCapturedAt) } : {}),
    },
    ...(embedding
      ? {
          embedding: {
            reachable: toBoolean(embedding.reachable),
            ...(toString(embedding.provider) ? { provider: toString(embedding.provider) } : {}),
            ...(toString(embedding.model) ? { model: toString(embedding.model) } : {}),
            ...(toNumber(embedding.dims) !== undefined ? { dims: toNumber(embedding.dims) } : {}),
          },
        }
      : {}),
    ...(knowledgeGraph ? { knowledgeGraph: { enabled: toBoolean(knowledgeGraph.enabled) } } : {}),
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

export function openBrainHealthRoutes() {
  const router = Router();

  router.get("/openbrain/health", async (_req, res) => {
    const healthFile = process.env.PAPERCLIP_OPENBRAIN_HEALTH_FILE || DEFAULT_HEALTH_FILE;
    try {
      const raw = JSON.parse(await readFile(healthFile, "utf8"));
      res.json(normalizeHealth(raw));
    } catch (err) {
      res.status(503).json({
        status: "down",
        checkedAt: new Date().toISOString(),
        openbrain: {
          dbOk: false,
        },
        errors: [
          {
            component: "openbrain-health-file",
            message: sanitizeMessage(err instanceof Error ? err.message : String(err)),
          },
        ],
      } satisfies OpenBrainHealthResponse);
    }
  });

  return router;
}
