import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactSensitiveText } from "../redaction.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

const RUN_LOG_FILE_MODE = 0o600;
const RUN_LOG_REDACTION_TOKEN = "<REDACTED>";
const SENSITIVE_ENV_KEY_RE = /(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_PRIVATE_KEY)$/;
const EXPLICIT_SENSITIVE_ENV_KEYS = new Set([
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_AGENT_JWT_PREVIOUS_SECRETS",
]);
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;
const GENERIC_SENSITIVE_ENV_ASSIGNMENT_RE =
  /(\b[A-Za-z0-9_]*(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_PRIVATE_KEY)\s*=\s*)(["']?)[^\s"'`]+(\2)/g;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSensitiveEnvKey(key: string) {
  return EXPLICIT_SENSITIVE_ENV_KEYS.has(key) || SENSITIVE_ENV_KEY_RE.test(key);
}

function getSensitiveEnvEntries() {
  return Object.entries(process.env).filter(
    ([key, value]) => isSensitiveEnvKey(key) && typeof value === "string" && value.length > 0,
  ) as Array<[string, string]>;
}

function redactEnvKeyContext(input: string, sensitiveKeys: readonly string[]) {
  let output = input.replace(GENERIC_SENSITIVE_ENV_ASSIGNMENT_RE, `$1$2${RUN_LOG_REDACTION_TOKEN}$3`);

  for (const key of sensitiveKeys) {
    const escapedKey = escapeRegExp(key);
    output = output.replace(
      new RegExp("(" + escapedKey + "\\s*=\\s*)([\"']?)[^\\s\"'`]+(\\2)", "g"),
      `$1$2${RUN_LOG_REDACTION_TOKEN}$3`,
    );
    output = output.replace(new RegExp(`(${escapedKey}\\s*:\\s*)\\S+`, "g"), `$1${RUN_LOG_REDACTION_TOKEN}`);
  }

  if (sensitiveKeys.some((key) => output.includes(key))) {
    const keySet = new Set(sensitiveKeys);
    output = output.replace(LONG_TOKEN_RE, (candidate) => (keySet.has(candidate) ? candidate : RUN_LOG_REDACTION_TOKEN));
  }

  return output;
}

function sanitizeRunLogText(input: string) {
  let output = redactSensitiveText(input);
  const sensitiveEntries = getSensitiveEnvEntries();
  const sensitiveKeys = [...new Set([...sensitiveEntries.map(([key]) => key), ...EXPLICIT_SENSITIVE_ENV_KEYS])];

  for (const [, value] of sensitiveEntries) {
    output = output.split(value).join(RUN_LOG_REDACTION_TOKEN);
  }

  return redactEnvKeyContext(output, sensitiveKeys);
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", { encoding: "utf8", mode: RUN_LOG_FILE_MODE });
      await fs.chmod(absPath, RUN_LOG_FILE_MODE);

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: sanitizeRunLogText(event.chunk),
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}
