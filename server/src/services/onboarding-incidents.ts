import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

const INCIDENT_DIR_NAME = "onboarding-incidents";
const INCIDENT_FILE_VERSION = 1;
const INCIDENT_FILE_EXT = ".json";
const INCIDENT_DECAY_MS = 30 * 24 * 60 * 60 * 1000;
const INCIDENT_DECAY_SCAN_LIMIT = 100;
const INCIDENT_INGEST_PER_REQUEST_LIMIT = 25;
const INCIDENT_INGEST_SCAN_LIMIT = 100;
const STORED_BODY_MAX_BYTES = 8 * 1024;
const STORED_HEADER_VALUE_MAX_BYTES = 256;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-paperclip-api-key",
  "x-paperclip-board-key",
]);
const SENSITIVE_BODY_KEYS = new Set([
  "password",
  "passwordconfirmation",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "refreshtoken",
]);

export const AUTO_FILED_ONBOARDING_5XX_ORIGIN_KIND = "auto_filed_onboarding_5xx";
export const AUTO_FILED_ONBOARDING_5XX_LABEL_NAME = "auto-filed:onboarding-5xx";
const AUTO_FILED_ONBOARDING_5XX_LABEL_COLOR = "#ef4444";

export interface OnboardingIncidentRecord {
  version: number;
  incidentId: string;
  capturedAt: string;
  method: string;
  routePattern: string;
  requestUrl: string;
  dedupHash: string;
  createdByUserId: string | null;
  actorSource: string | null;
  error: { name: string; message: string; stack: string | null };
  redactedBody: unknown;
  redactedHeaders: Record<string, string>;
  bodyTruncated: { truncated: false } | { truncated: true; originalByteSize: number };
}

export interface RecordIncidentInput {
  incidentId: string;
  capturedAt?: Date;
  method: string;
  routePattern: string;
  requestUrl: string;
  reqBody: unknown;
  reqHeaders: Record<string, string | string[] | undefined>;
  error: { name?: string | null; message?: string | null; stack?: string | null };
  companyId?: string | null;
  createdByUserId: string | null;
  actorSource: string | null;
}

export interface RecordIncidentResult {
  incidentId: string;
  dedupHash: string;
  filed: "issue" | "deferred" | "deduped" | "skipped";
  issueId?: string;
}

export interface OnboardingIncidentsServiceOptions {
  incidentDir?: string;
  now?: () => Date;
}

export interface OnboardingIncidentsService {
  recordIncident(input: RecordIncidentInput): Promise<RecordIncidentResult>;
  ingestPendingIncidents(
    companyId: string,
    opts: { creatorUserId: string | null; actorSource: string | null },
  ): Promise<{ ingestedCount: number; skippedCount: number }>;
  __testOnly: {
    getIncidentDir(): string;
    decayOnce(): Promise<{ deletedCount: number; inspectedCount: number }>;
  };
}

export function onboardingIncidentsService(
  db: Db,
  options: OnboardingIncidentsServiceOptions = {},
): OnboardingIncidentsService {
  const incidentDir = options.incidentDir
    ?? path.join(resolvePaperclipInstanceRoot(), INCIDENT_DIR_NAME);
  const now = options.now ?? (() => new Date());
  const issues = issueService(db);

  async function ensureIncidentDir() {
    await fs.mkdir(incidentDir, { recursive: true, mode: 0o700 });
  }

  function buildDedupHash(method: string, routePattern: string, errorName: string, errorMessage: string) {
    return createHash("sha256")
      .update(`${method.toUpperCase()} ${routePattern} ${errorName} ${errorMessage}`)
      .digest("hex");
  }

  function redactHeaders(reqHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(reqHeaders)) {
      if (value == null) continue;
      const normalized = key.toLowerCase();
      if (SENSITIVE_HEADERS.has(normalized)) continue;
      const flattened = Array.isArray(value) ? value.join(", ") : String(value);
      const masked = redactCurrentUserValue(flattened);
      out[normalized] = masked.length > STORED_HEADER_VALUE_MAX_BYTES
        ? `${masked.slice(0, STORED_HEADER_VALUE_MAX_BYTES)}…`
        : masked;
    }
    return out;
  }

  function redactBody(body: unknown): unknown {
    if (body == null) return body;
    const masked = redactCurrentUserValue(body);
    return stripSensitiveBodyKeys(masked);
  }

  function stripSensitiveBodyKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripSensitiveBodyKeys);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
          next[key] = "[redacted]";
          continue;
        }
        next[key] = stripSensitiveBodyKeys(entry);
      }
      return next;
    }
    return value;
  }

  function serializeBodyWithCap(body: unknown): {
    serialized: string;
    truncation: OnboardingIncidentRecord["bodyTruncated"];
  } {
    let serialized: string;
    try {
      serialized = JSON.stringify(body, null, 2) ?? "null";
    } catch {
      serialized = "\"[unserializable body]\"";
    }
    const byteSize = Buffer.byteLength(serialized, "utf8");
    if (byteSize <= STORED_BODY_MAX_BYTES) {
      return { serialized, truncation: { truncated: false } };
    }
    const truncated = truncateUtf8ByBytes(serialized, STORED_BODY_MAX_BYTES);
    return {
      serialized: `${truncated}\n[truncated ${byteSize - STORED_BODY_MAX_BYTES} bytes]`,
      truncation: { truncated: true, originalByteSize: byteSize },
    };
  }

  function buildIncidentRecord(input: RecordIncidentInput): OnboardingIncidentRecord {
    const errorName = (input.error.name ?? "Error").slice(0, 200);
    const errorMessage = (input.error.message ?? "").slice(0, 2_000);
    const stack = input.error.stack ? redactCurrentUserValue(input.error.stack).slice(0, 8_000) : null;
    const redactedBody = redactBody(input.reqBody);
    const { truncation } = serializeBodyWithCap(redactedBody);
    return {
      version: INCIDENT_FILE_VERSION,
      incidentId: input.incidentId,
      capturedAt: (input.capturedAt ?? now()).toISOString(),
      method: input.method.toUpperCase(),
      routePattern: input.routePattern,
      requestUrl: input.requestUrl,
      dedupHash: buildDedupHash(input.method, input.routePattern, errorName, errorMessage),
      createdByUserId: input.createdByUserId,
      actorSource: input.actorSource,
      error: { name: errorName, message: errorMessage, stack },
      redactedBody,
      redactedHeaders: redactHeaders(input.reqHeaders),
      bodyTruncated: truncation,
    };
  }

  function renderIssueBody(record: OnboardingIncidentRecord, opts: { includeDeferredNote?: boolean } = {}) {
    const { serialized } = serializeBodyWithCap(record.redactedBody);
    const headerLines = Object.entries(record.redactedHeaders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `- \`${key}\`: ${value}`)
      .join("\n");
    const headersSection = headerLines.length > 0 ? headerLines : "_(none)_";
    const deferredNote = opts.includeDeferredNote
      ? "\n\n> Originally captured before any company existed; ingested on first successful company creation.\n"
      : "";
    return `## Onboarding 5xx auto-filed

- **Route:** \`${record.method} ${record.routePattern}\`
- **Request URL:** \`${record.requestUrl}\`
- **Error:** \`${record.error.name}\` — ${record.error.message || "_(no message)_"}
- **Captured at:** ${record.capturedAt}
- **Incident ID:** \`${record.incidentId}\`
- **Dedup hash:** \`${record.dedupHash}\`${deferredNote}

### Stack
\`\`\`
${record.error.stack ?? "(no stack)"}
\`\`\`

### Redacted request body
\`\`\`json
${serialized}
\`\`\`

### Redacted request headers
${headersSection}
`;
  }

  async function getOrCreateLabel(companyId: string): Promise<string | null> {
    try {
      const existing = await issues.listLabels(companyId);
      const match = existing.find((row) => row.name === AUTO_FILED_ONBOARDING_5XX_LABEL_NAME);
      if (match) return match.id;
      const created = await issues.createLabel(companyId, {
        name: AUTO_FILED_ONBOARDING_5XX_LABEL_NAME,
        color: AUTO_FILED_ONBOARDING_5XX_LABEL_COLOR,
      });
      return created?.id ?? null;
    } catch (err) {
      logger.warn({ err, companyId }, "Failed to upsert onboarding-5xx label");
      return null;
    }
  }

  async function findDedupIssue(companyId: string, dedupHash: string) {
    const cutoff = new Date(now().getTime() - DEDUP_WINDOW_MS);
    const rows = await issues.list(companyId, {
      originKind: AUTO_FILED_ONBOARDING_5XX_ORIGIN_KIND,
      originId: dedupHash,
      limit: 5,
    });
    if (!Array.isArray(rows)) return null;
    for (const candidate of rows) {
      const createdAt = candidate.createdAt instanceof Date
        ? candidate.createdAt
        : new Date(candidate.createdAt as string);
      if (createdAt.getTime() >= cutoff.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  async function fileIssueForRecord(
    companyId: string,
    record: OnboardingIncidentRecord,
    opts: { includeDeferredNote?: boolean } = {},
  ): Promise<{ issueId: string; mode: "issue" | "deduped" }> {
    const existing = await findDedupIssue(companyId, record.dedupHash);
    if (existing) {
      try {
        await issues.addComment(
          existing.id,
          `Repeat hit at ${record.capturedAt}. Same route (\`${record.method} ${record.routePattern}\`) and error (\`${record.error.name}\`). Incident ID: \`${record.incidentId}\`.`,
          { agentId: undefined, userId: undefined, runId: null },
          { authorType: "system" },
        );
      } catch (err) {
        logger.warn({ err, issueId: existing.id }, "Failed to post dedup counter comment");
      }
      return { issueId: existing.id, mode: "deduped" };
    }

    const labelId = await getOrCreateLabel(companyId);
    const title = `Onboarding 5xx: ${record.method} ${record.routePattern} → ${record.error.name}`;
    const description = renderIssueBody(record, opts);
    const created = await issues.create(companyId, {
      title: title.length > 240 ? `${title.slice(0, 237)}...` : title,
      description,
      priority: "high",
      status: "backlog",
      originKind: AUTO_FILED_ONBOARDING_5XX_ORIGIN_KIND,
      originId: record.dedupHash,
      ...(labelId ? { labelIds: [labelId] } : {}),
    });
    return { issueId: created.id, mode: "issue" };
  }

  async function writeIncidentFile(record: OnboardingIncidentRecord) {
    await ensureIncidentDir();
    const filename = `${Date.parse(record.capturedAt)}-${record.incidentId}${INCIDENT_FILE_EXT}`;
    const finalPath = path.join(incidentDir, filename);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, finalPath);
    return finalPath;
  }

  async function decayOnce(): Promise<{ deletedCount: number; inspectedCount: number }> {
    let deletedCount = 0;
    let inspectedCount = 0;
    try {
      const entries = await fs.readdir(incidentDir).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw err;
      });
      const cutoff = now().getTime() - INCIDENT_DECAY_MS;
      for (const entry of entries) {
        if (inspectedCount >= INCIDENT_DECAY_SCAN_LIMIT) break;
        if (!entry.endsWith(INCIDENT_FILE_EXT)) continue;
        inspectedCount += 1;
        const entryPath = path.join(incidentDir, entry);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat) continue;
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(entryPath).catch((err) => {
            logger.warn({ err, entryPath }, "Failed to decay onboarding incident file");
          });
          deletedCount += 1;
        }
      }
    } catch (err) {
      logger.warn({ err }, "Onboarding incident decay sweep failed");
    }
    return { deletedCount, inspectedCount };
  }

  return {
    async recordIncident(input) {
      const record = buildIncidentRecord(input);
      void decayOnce();

      if (input.companyId) {
        try {
          const filed = await fileIssueForRecord(input.companyId, record);
          return {
            incidentId: record.incidentId,
            dedupHash: record.dedupHash,
            filed: filed.mode,
            issueId: filed.issueId,
          };
        } catch (err) {
          logger.error(
            { err, companyId: input.companyId, incidentId: record.incidentId },
            "Failed to auto-file onboarding 5xx issue",
          );
          return {
            incidentId: record.incidentId,
            dedupHash: record.dedupHash,
            filed: "skipped",
          };
        }
      }

      try {
        await writeIncidentFile(record);
        return {
          incidentId: record.incidentId,
          dedupHash: record.dedupHash,
          filed: "deferred",
        };
      } catch (err) {
        logger.error(
          { err, incidentId: record.incidentId },
          "Failed to write deferred onboarding incident file",
        );
        return {
          incidentId: record.incidentId,
          dedupHash: record.dedupHash,
          filed: "skipped",
        };
      }
    },

    async ingestPendingIncidents(companyId, opts) {
      let ingestedCount = 0;
      let skippedCount = 0;
      let entries: string[];
      try {
        entries = await fs.readdir(incidentDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ingestedCount, skippedCount };
        logger.warn({ err, companyId }, "Failed to scan onboarding incident dir for ingest");
        return { ingestedCount, skippedCount };
      }
      const incidentFiles = entries.filter((entry) => entry.endsWith(INCIDENT_FILE_EXT));
      let processedCount = 0;
      for (const entry of incidentFiles) {
        if (ingestedCount >= INCIDENT_INGEST_PER_REQUEST_LIMIT) break;
        if (processedCount >= INCIDENT_INGEST_SCAN_LIMIT) break;
        processedCount += 1;
        const entryPath = path.join(incidentDir, entry);
        let parsed: OnboardingIncidentRecord | null = null;
        try {
          const raw = await fs.readFile(entryPath, "utf8");
          parsed = JSON.parse(raw) as OnboardingIncidentRecord;
        } catch (err) {
          logger.warn({ err, entryPath }, "Skipping unreadable onboarding incident file");
          continue;
        }
        if (!parsed || parsed.version !== INCIDENT_FILE_VERSION) {
          skippedCount += 1;
          continue;
        }
        if (!isIncidentEligibleForCreator(parsed, opts)) {
          skippedCount += 1;
          continue;
        }
        try {
          await fileIssueForRecord(companyId, parsed, { includeDeferredNote: true });
          await fs.unlink(entryPath).catch((err) => {
            logger.warn({ err, entryPath }, "Failed to delete ingested incident file");
          });
          ingestedCount += 1;
        } catch (err) {
          logger.error({ err, entryPath, companyId }, "Failed to ingest deferred incident");
          skippedCount += 1;
        }
      }
      return { ingestedCount, skippedCount };
    },

    __testOnly: {
      getIncidentDir: () => incidentDir,
      decayOnce,
    },
  };
}

// Trim a UTF-8 byte buffer back to the last complete code point so the cut
// never lands inside a multi-byte sequence (which would emit U+FFFD on decode).
function truncateUtf8ByBytes(input: string, maxBytes: number): string {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.length <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const start = buffer[end - 1];
    const need =
      (start & 0x80) === 0 ? 1
        : (start & 0xe0) === 0xc0 ? 2
          : (start & 0xf0) === 0xe0 ? 3
            : (start & 0xf8) === 0xf0 ? 4
              : 1;
    if (need > maxBytes - (end - 1)) end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function isIncidentEligibleForCreator(
  record: OnboardingIncidentRecord,
  opts: { creatorUserId: string | null; actorSource: string | null },
): boolean {
  if (record.createdByUserId && opts.creatorUserId) {
    return record.createdByUserId === opts.creatorUserId;
  }
  if (record.createdByUserId == null && opts.creatorUserId == null) {
    return record.actorSource === "local_implicit" && opts.actorSource === "local_implicit";
  }
  return false;
}
