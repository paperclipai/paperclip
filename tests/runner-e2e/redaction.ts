import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticText } from "../../packages/adapter-utils/src/command-redaction.js";
import { CREDENTIAL_NAMES } from "./types.js";

const SECRET_SHAPES = [
  /\b(?:github_pat_|ghp_)[A-Za-z0-9_]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:openrouter|daytona)[-_]?(?:api)?[-_]?key["'=:\s]+[A-Za-z0-9._-]{12,}\b/gi,
] as const;

const SENSITIVE_JSON_KEY =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|cookie|password|secret|token)$/i;

const SAFE_SECRET_SOURCES = new Set<string>([...CREDENTIAL_NAMES, "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "BETTER_AUTH_SECRET"]);
// Credential dictionaries can have account identities as keys. Only known
// schema fields, never arbitrary JSON keys, may become diagnostic labels.
const SAFE_SECRET_FIELDS = new Set(["tokens", "account_id", "access_token", "refresh_token", "id_token", "token",
  "accountId", "accessToken", "refreshToken", "idToken", "accounts", "credentials", "auth", "user", "account",
  "api_key", "apiKey", "client_id", "client_secret", "session", "cookie", "email", "username", "identity", "id",
  "expires_at", "expiresAt", "last_refresh"]);

function secretEntries(value: string | undefined): Array<{ value: string; fieldPath: string }> {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const entries = [{ value: trimmed, fieldPath: "" }];
  if (trimmed.startsWith("{")) {
    try {
      const visit = (child: unknown, fieldPath: string, depth: number) => {
        if (depth > 8) return;
        if (typeof child === "string") {
          if (child.length >= 8) entries.push({ value: child, fieldPath });
        } else if (child && typeof child === "object") {
          for (const [key, next] of Object.entries(child)) {
            if (key.includes("::")) entries.push({ value: key, fieldPath: `${fieldPath}.[key]` });
            const nextPath = Array.isArray(child) ? `${fieldPath}[${key}]`
              : `${fieldPath}.${SAFE_SECRET_FIELDS.has(key) ? key : "[field]"}`;
            visit(next, nextPath, depth + 1);
          }
        }
      };
      visit(JSON.parse(trimmed), "", 0);
    } catch { /* Preserve ordinary non-JSON secrets. */ }
  }
  return entries;
}

export function normalizedSecrets(values: readonly (string | undefined)[]) {
  return [...new Set(values.flatMap(value => secretEntries(value).map(entry => entry.value)))].sort((left, right) => right.length - left.length);
}

export interface SecretScanOptions {
  includeShapes?: boolean;
  sources?: Readonly<Record<string, string | undefined>>;
}

export interface SecretLeakMatch { reason: string; matchCategory?: string }

function secretMatchIndex(secrets: readonly string[], sources?: SecretScanOptions["sources"]) {
  const labels = new Map<string, string>();
  for (const [name, value] of Object.entries(sources ?? {})) {
    const source = SAFE_SECRET_SOURCES.has(name) ? name : "other credential";
    for (const entry of secretEntries(value)) {
      if (!labels.has(entry.value)) labels.set(entry.value, source + entry.fieldPath);
    }
  }
  return normalizedSecrets(secrets).map(value => ({ value, matchCategory: labels.get(value) ?? "unattributed credential" }));
}

function matchSecret(text: string, index: ReturnType<typeof secretMatchIndex>, options: SecretScanOptions): SecretLeakMatch | null {
  for (const entry of index) {
    if (text.includes(entry.value)) return { reason: "exact secret value",
      ...(options.sources ? { matchCategory: entry.matchCategory } : {}) };
  }
  if (options.includeShapes !== false) {
    for (const pattern of SECRET_SHAPES) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return { reason: "secret-shaped value",
        ...(options.sources ? { matchCategory: "provider key shape" } : {}) };
    }
  }
  return null;
}

/** Diagnostic classification carries no matched bytes or arbitrary JSON keys. */
export function findSecretLeakMatch(value: string | Buffer, secrets: readonly string[], options: SecretScanOptions = {}) {
  return matchSecret(Buffer.isBuffer(value) ? value.toString("utf8") : value, secretMatchIndex(secrets, options.sources), options);
}

export function isEphemeralCodexRuntimeAuthFile(
  paperclipHome: string,
  file: string,
) {
  const relative = path.relative(paperclipHome, file).split(path.sep).join("/");
  return (
    /^instances\/[^/]+\/companies\/[^/]+\/agents\/[^/]+\/codex-home\/auth\.json$/.test(
      relative,
    ) ||
    /^instances\/[^/]+\/runtime\/paperclip-runner\/durable-sessions\/[^/]+\/codex-home\/auth\.json$/.test(
      relative,
    ) ||
    /^instances\/[^/]+\/runtime\/paperclip-runner\/acpx\/acpx\/[^/]+\/codex-home\/auth\.json$/.test(
      relative,
    )
  );
}

/** Browser navigation diagnostics need a route, never OAuth query credentials. */
export function browserDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin + url.pathname : "[non-HTTP URL]";
  } catch { return "[invalid URL]"; }
}

export function redactText(value: string, secrets: readonly string[]) {
  let redacted = redactDiagnosticText(value, "[REDACTED]");
  return redactKnownSecretsAndShapes(redacted, secrets);
}

function redactKnownSecretsAndShapes(
  value: string,
  secrets: readonly string[],
) {
  let redacted = value;
  for (const secret of normalizedSecrets(secrets))
    redacted = redacted.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_SHAPES)
    redacted = redacted.replace(pattern, "[REDACTED_SECRET_SHAPE]");
  return redacted;
}

function redactStructuredText(value: string, secrets: readonly string[]) {
  const knownSafe = redactKnownSecretsAndShapes(value, secrets);
  if (
    !/(?:Authorization\s*:\s*Bearer|(?:api[-_]?key|token|secret|password)\s*=)/i.test(
      knownSafe,
    )
  ) {
    return knownSafe;
  }
  return redactKnownSecretsAndShapes(
    redactDiagnosticText(knownSafe, "[REDACTED]"),
    secrets,
  );
}

export function findSecretLeak(
  value: string | Buffer,
  secrets: readonly string[],
  options: { includeShapes?: boolean } = {},
): string | null {
  return findSecretLeakMatch(value, secrets, options)?.reason ?? null;
}

/**
 * Scan structured JSON one key/value string at a time. Scanning the serialized
 * document for provider key shapes can join an object key, punctuation, and an
 * unrelated value into a false positive that never existed in the payload.
 */
export function findSecretLeakInJsonValues(
  value: unknown,
  secrets: readonly string[],
  options: { includeShapes?: boolean } = {},
): string | null {
  if (typeof value === "string") return findSecretLeak(value, secrets, options);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const leak = findSecretLeakInJsonValues(entry, secrets, options);
      if (leak) return leak;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const keyLeak = findSecretLeak(key, secrets, options);
      if (keyLeak) return keyLeak;
      const valueLeak = findSecretLeakInJsonValues(entry, secrets, options);
      if (valueLeak) return valueLeak;
    }
  }
  return null;
}

export function sanitizeJson(
  value: unknown,
  secrets: readonly string[],
): unknown {
  // Structured values are not shell diagnostics. Applying the command/JWT
  // heuristic here would redact stable dotted identifiers such as our schema
  // name. Exact loaded secrets and well-known provider key shapes are enough.
  if (typeof value === "string") return redactStructuredText(value, secrets);
  if (Array.isArray(value))
    return value.map((entry) => sanitizeJson(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_JSON_KEY.test(key)
          ? "[REDACTED]"
          : sanitizeJson(entry, secrets),
      ]),
    );
  }
  return value;
}

/** Preserve the original outcome when the independent persistence gate wins. */
export function secretScanFailureEvidence(input: {
  scanError: string;
  finding?: SecretLeakMatch & { file: string; stateArea: string };
  originalResult: { status: string; failureClass?: string; error?: string };
}, secrets: readonly string[]) {
  return sanitizeJson({ schema: "paperclip.e2e.persisted-state-scan.v1", ...input }, secrets);
}

export function assertSecretFree(
  value: string | Buffer,
  secrets: readonly string[],
  label: string,
  options: { includeShapes?: boolean } = {},
) {
  const leak = findSecretLeak(value, secrets, options);
  if (leak) throw new Error(`Secret leak in ${label}: ${leak}`);
}

export function isEphemeralPostgresPidFile(paperclipHome: string, file: string): boolean {
  const relative = path.relative(paperclipHome, file).split(path.sep).join("/");
  return /^instances\/[^/]+\/db\/postmaster\.pid$/.test(relative);
}

export function isEphemeralPostgresScanFile(paperclipHome: string, file: string): boolean {
  const relative = path.relative(paperclipHome, file).split(path.sep).join("/");
  // A relation can be unlinked during PostgreSQL shutdown/checkpoint. Existing
  // files are always scanned; this predicate only permits ENOENT after readdir.
  return isEphemeralPostgresPidFile(paperclipHome, file) ||
    /^instances\/[^/]+\/db\/base\/\d+\/\d+(?:_(?:fsm|vm|init))?(?:\.\d+)?$/.test(relative);
}

export async function findSecretLeakInDirectory(
  root: string,
  secrets: readonly string[],
  options: {
    includeShapes?: boolean;
    sources?: SecretScanOptions["sources"];
    ignoreFile?: (file: string) => boolean;
    allowDisappearedFile?: (file: string) => boolean;
  } = {},
): Promise<({ file: string } & SecretLeakMatch) | null> {
  const index = secretMatchIndex(secrets, options.sources);
  const overlap = Math.max(
    256,
    ...index.map(entry => entry.value.length + 16),
  );
  const scan = async (
    directory: string,
  ): Promise<{
    file: string;
    reason: string;
    matchCategory?: string;
  } | null> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const leak = await scan(file);
        if (leak) return leak;
      } else if (entry.isFile()) {
        if (options.ignoreFile?.(file)) continue;
        let carry = Buffer.alloc(0);
        try {
          for await (const chunk of createReadStream(file)) {
            const data = Buffer.concat([
              carry,
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            ]);
            const match = matchSecret(data.toString("utf8"), index, options);
            if (match) return { file, ...match };
            carry = data.subarray(Math.max(0, data.length - overlap));
          }
        } catch (error) {
          // PostgreSQL removes its PID file on shutdown, possibly after readdir.
          // Existing contents are still scanned; only the caller's exact
          // transient paths may disappear. Evidence and other I/O errors fail.
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" ||
              !options.allowDisappearedFile?.(file)) throw error;
        }
      }
    }
    return null;
  };
  return scan(root);
}
