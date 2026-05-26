import { readFile } from "node:fs/promises";
import { Router } from "express";

const HEALTH_CACHE_TTL_MS = 1_000;
const SECRET_KEY_PATTERN = /(?:^|[_-])(apiKey|accessToken|authToken|bearerToken|connectionString|databaseUrl|dbUrl|key|password|secret|serviceRole|token)(?:$|[_-])/i;

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
    .replace(/https?:\/\/[^\s"']*(?:supabase|\bdb\b)[^\s"']*/gi, "https://[REDACTED]");
}

function redactOperationalDetails(value: unknown): string {
  const message = sanitizeMessage(value);
  return message
    .replace(/\b(?:ENOENT|EACCES|EPERM):[^,]*(?:,\s*)?/gi, (match) => `${match.split(":")[0]}: [REDACTED], `)
    .replace(/\/[^\s"']+/g, "/[REDACTED]");
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
  const supabaseLatencyMs = supabase ? toNumber(supabase.latencyMs) : undefined;
  const memoryCount = toNumber(openbrain.memoryCount);
  const lastCapturedAt = toString(openbrain.lastCapturedAt);
  const embeddingProvider = embedding ? toString(embedding.provider) : undefined;
  const embeddingModel = embedding ? toString(embedding.model) : undefined;
  const embeddingDims = embedding ? toNumber(embedding.dims) : undefined;
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
            ...(supabaseLatencyMs !== undefined ? { latencyMs: supabaseLatencyMs } : {}),
          },
        }
      : {}),
    openbrain: {
      dbOk: toBoolean(openbrain.dbOk),
      ...(memoryCount !== undefined ? { memoryCount } : {}),
      ...(lastCapturedAt ? { lastCapturedAt } : {}),
    },
    ...(embedding
      ? {
          embedding: {
            reachable: toBoolean(embedding.reachable),
            ...(embeddingProvider ? { provider: embeddingProvider } : {}),
            ...(embeddingModel ? { model: embeddingModel } : {}),
            ...(embeddingDims !== undefined ? { dims: embeddingDims } : {}),
          },
        }
      : {}),
    ...(knowledgeGraph ? { knowledgeGraph: { enabled: toBoolean(knowledgeGraph.enabled) } } : {}),
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

export function openBrainHealthRoutes() {
  const router = Router();
  let cachedHealth: OpenBrainHealthResponse | undefined;
  let cachedHealthFile: string | undefined;
  let cachedAt = 0;

  router.get("/openbrain/health", async (_req, res) => {
    const healthFile = process.env.PAPERCLIP_OPENBRAIN_HEALTH_FILE;
    try {
      if (!healthFile) {
        throw new Error("PAPERCLIP_OPENBRAIN_HEALTH_FILE is required");
      }
      const now = Date.now();
      if (cachedHealth && cachedHealthFile === healthFile && now - cachedAt < HEALTH_CACHE_TTL_MS) {
        res.json(cachedHealth);
        return;
      }
      const raw = JSON.parse(await readFile(healthFile, "utf8"));
      cachedHealth = normalizeHealth(raw);
      cachedHealthFile = healthFile;
      cachedAt = now;
      res.json(cachedHealth);
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
            message: redactOperationalDetails(err instanceof Error ? err.message : String(err)),
          },
        ],
      } satisfies OpenBrainHealthResponse);
    }
  });

  return router;
}
