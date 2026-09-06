import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticText } from "../../packages/adapter-utils/src/command-redaction.js";

const SECRET_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:openrouter|daytona)[-_]?(?:api)?[-_]?key["'=:\s]+[A-Za-z0-9._-]{12,}\b/gi,
] as const;

const SENSITIVE_JSON_KEY =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|cookie|password|secret|token)$/i;

export function normalizedSecrets(values: readonly (string | undefined)[]) {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort((left, right) => right.length - left.length);
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
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  for (const secret of normalizedSecrets(secrets)) {
    if (text.includes(secret)) return "exact secret value";
  }
  if (options.includeShapes !== false) {
    for (const pattern of SECRET_SHAPES) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return "secret-shaped value";
    }
  }
  return null;
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

export function assertSecretFree(
  value: string | Buffer,
  secrets: readonly string[],
  label: string,
  options: { includeShapes?: boolean } = {},
) {
  const leak = findSecretLeak(value, secrets, options);
  if (leak) throw new Error(`Secret leak in ${label}: ${leak}`);
}

export async function findSecretLeakInDirectory(
  root: string,
  secrets: readonly string[],
  options: {
    includeShapes?: boolean;
    ignoreFile?: (file: string) => boolean;
  } = {},
): Promise<{ file: string; reason: string } | null> {
  const overlap = Math.max(
    256,
    ...normalizedSecrets(secrets).map((secret) => secret.length + 16),
  );
  const scan = async (
    directory: string,
  ): Promise<{
    file: string;
    reason: string;
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
        for await (const chunk of createReadStream(file)) {
          const data = Buffer.concat([
            carry,
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          ]);
          const reason = findSecretLeak(data, secrets, options);
          if (reason) return { file, reason };
          carry = data.subarray(Math.max(0, data.length - overlap));
        }
      }
    }
    return null;
  };
  return scan(root);
}
