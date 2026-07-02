/**
 * Secret scrubber for company portability bundles.
 *
 * Runs a deterministic regex sweep over every free-text string in an export
 * bundle (manifest values + file bodies) and reports matches with a precise
 * path and pattern name. Use to:
 *
 *   1. Refuse to write a bundle that contains a high-severity secret, unless
 *      the caller has explicitly opted in with `allowSecrets`.
 *   2. Replace matches in-place with `<REDACTED:<pattern>>` markers when the
 *      caller has opted in, so the bundle is still useful for inspection
 *      without leaking the underlying token.
 *
 * The scrubber is intentionally separate from `feedback-redaction.ts`:
 *   - feedback-redaction sanitises telemetry, where false positives are
 *     acceptable (we'd rather over-redact a PII-like number than leak it).
 *   - this scrubber gates portability bundles, where false positives stop a
 *     legitimate export. Patterns here are tightened to credential shapes
 *     with low collision against human prose.
 */

import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

export type ScrubSeverity = "high";

export interface ScrubPattern {
  name: string;
  severity: ScrubSeverity;
  regex: RegExp;
  marker: string;
  /**
   * Optional custom replacer for patterns whose marker depends on captured
   * context (e.g. preserve an identifier prefix while replacing only the
   * secret value). Returning the original match string is treated as a no-op
   * and not counted toward `counts` — use this to gate matches whose regex is
   * intentionally loose (case-insensitive) but whose accepted value is strict.
   */
  replacer?: (match: string, ...groups: string[]) => string;
}

export interface ScrubMatch {
  patternName: string;
  severity: ScrubSeverity;
  path: string;
  count: number;
}

const HIGH_SEVERITY_PATTERNS: ScrubPattern[] = [
  {
    name: "provider_api_key",
    severity: "high",
    regex: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|pk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,})\b/g,
    marker: "<REDACTED:provider_api_key>",
  },
  {
    name: "github_pat",
    severity: "high",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    marker: "<REDACTED:github_pat>",
  },
  {
    name: "slack_token",
    severity: "high",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    marker: "<REDACTED:slack_token>",
  },
  {
    name: "pem_private_key",
    severity: "high",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    marker: "<REDACTED:pem_private_key>",
  },
  {
    name: "jwt",
    severity: "high",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    marker: "<REDACTED:jwt>",
  },
  {
    name: "bearer_token",
    severity: "high",
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
    marker: "Bearer <REDACTED:bearer_token>",
  },
  {
    // 64-char lowercase hex string — shape of PAPERCLIP_AGENT_JWT_SECRET.
    // Anchored to a credential-context identifier (`SECRET`, `KEY`, `TOKEN`,
    // `PASSWORD`, `AUTH`, `CREDENTIAL`, `SIGNING`, `SIGNATURE`, `NONCE`)
    // followed by an `=` or `:` assignment so we don't collide with bare
    // 64-char lowercase hex used as Docker `sha256:<digest>` references,
    // `sha256sum` output, or pinned-dependency content hashes. The hex itself
    // must remain lowercase — the post-match `replacer` filters mixed-case
    // matches that slip through the `i` flag on the keyword portion.
    name: "hex_secret_64",
    severity: "high",
    regex: /(\b(?=[A-Za-z])[A-Za-z0-9_-]*?(?:secret|key|token|password|passwd|pass|auth|credential|signing|signature|nonce)[A-Za-z0-9_-]*['"]?\s*[:=]\s*['"]?)([a-f0-9]{64})\b/gi,
    marker: "<REDACTED:hex_secret_64>",
    replacer: (match, prefix, hex) =>
      /^[a-f0-9]{64}$/.test(hex) ? `${prefix}<REDACTED:hex_secret_64>` : match,
  },
  {
    name: "credential_url",
    severity: "high",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s<>'")]+/gi,
    marker: "<REDACTED:credential_url>",
  },
];

const PATTERNS: readonly ScrubPattern[] = Object.freeze(HIGH_SEVERITY_PATTERNS);

export function listScrubPatterns(): readonly ScrubPattern[] {
  return PATTERNS;
}

/**
 * Apply every pattern to `input`, returning the redacted text plus a per-pattern
 * match count. Pure / stateless / synchronous; safe to call with any string.
 */
export function scrubText(input: string): { text: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  let output = input;
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let n = 0;
    if (pattern.replacer) {
      const replacer = pattern.replacer;
      output = output.replace(pattern.regex, (match, ...groups) => {
        const replacement = replacer(match, ...(groups.filter((g): g is string => typeof g === "string")));
        if (replacement === match) return match;
        n += 1;
        return replacement;
      });
    } else {
      output = output.replace(pattern.regex, () => {
        n += 1;
        return pattern.marker;
      });
    }
    pattern.regex.lastIndex = 0;
    if (n > 0) counts.set(pattern.name, n);
  }
  return { text: output, counts };
}

/**
 * Detect-only sweep over `input` — returns the same per-pattern counts as
 * `scrubText` without paying for the string rebuild. Used by the export gate
 * so the failure path doesn't redact a bundle we're about to refuse anyway.
 */
export function detectText(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let n = 0;
    if (pattern.replacer) {
      const replacer = pattern.replacer;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(input)) !== null) {
        const groups = m.slice(1).filter((g): g is string => typeof g === "string");
        if (replacer(m[0], ...groups) !== m[0]) n += 1;
      }
    } else {
      const matches = input.match(pattern.regex);
      n = matches?.length ?? 0;
    }
    pattern.regex.lastIndex = 0;
    if (n > 0) counts.set(pattern.name, n);
  }
  return counts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordMatches(
  matches: ScrubMatch[],
  path: string,
  counts: Map<string, number>,
) {
  for (const [name, count] of counts) {
    const pattern = PATTERNS.find((p) => p.name === name);
    if (!pattern) continue;
    matches.push({ patternName: name, severity: pattern.severity, path, count });
  }
}

function detectValue(value: unknown, path: string, matches: ScrubMatch[]): void {
  if (typeof value === "string") {
    const counts = detectText(value);
    if (counts.size > 0) {
      recordMatches(matches, path, counts);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      detectValue(value[i], `${path}[${i}]`, matches);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      detectValue(entry, path ? `${path}.${key}` : key, matches);
    }
  }
}

function scrubValue(value: unknown, path: string, matches: ScrubMatch[]): unknown {
  if (typeof value === "string") {
    const result = scrubText(value);
    if (result.counts.size > 0) {
      recordMatches(matches, path, result.counts);
      return result.text;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => scrubValue(entry, `${path}[${index}]`, matches));
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = scrubValue(entry, path ? `${path}.${key}` : key, matches);
    }
    return next;
  }
  return value;
}

export function scrubManifest<T>(manifest: T): { manifest: T; matches: ScrubMatch[] } {
  const matches: ScrubMatch[] = [];
  const scrubbed = scrubValue(manifest, "manifest", matches) as T;
  return { manifest: scrubbed, matches };
}

/**
 * Detect-only manifest sweep — returns matches without rebuilding the object
 * graph. Use to gate exports before deciding whether to redact.
 */
export function detectSecretsInManifest(manifest: unknown): ScrubMatch[] {
  const matches: ScrubMatch[] = [];
  detectValue(manifest, "manifest", matches);
  return matches;
}

/**
 * Scrub a files map. Base64 file entries are passed through untouched — we
 * cannot reliably detect secrets in arbitrary binary blobs, and false positives
 * over base64 would block every export with a company logo. Operators that
 * paste secrets into images already have a worse problem than this scrubber
 * can solve.
 */
export function scrubFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
): { files: Record<string, CompanyPortabilityFileEntry>; matches: ScrubMatch[] } {
  const matches: ScrubMatch[] = [];
  const next: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, entry] of Object.entries(files)) {
    if (typeof entry !== "string") {
      next[filePath] = entry;
      continue;
    }
    const result = scrubText(entry);
    if (result.counts.size > 0) {
      recordMatches(matches, `files[${JSON.stringify(filePath)}]`, result.counts);
      next[filePath] = result.text;
    } else {
      next[filePath] = entry;
    }
  }
  return { files: next, matches };
}

/**
 * Detect-only files sweep — counterpart to `detectSecretsInManifest`. Base64
 * entries are skipped on the same grounds as `scrubFiles`.
 */
export function detectSecretsInFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
): ScrubMatch[] {
  const matches: ScrubMatch[] = [];
  for (const [filePath, entry] of Object.entries(files)) {
    if (typeof entry !== "string") continue;
    const counts = detectText(entry);
    if (counts.size > 0) {
      recordMatches(matches, `files[${JSON.stringify(filePath)}]`, counts);
    }
  }
  return matches;
}

export function summarizeMatches(matches: ScrubMatch[]): {
  total: number;
  highSeverity: number;
  byPattern: Record<string, number>;
} {
  let total = 0;
  let highSeverity = 0;
  const byPattern: Record<string, number> = {};
  for (const match of matches) {
    total += match.count;
    if (match.severity === "high") highSeverity += match.count;
    byPattern[match.patternName] = (byPattern[match.patternName] ?? 0) + match.count;
  }
  return { total, highSeverity, byPattern };
}

export function formatMatchWarnings(matches: ScrubMatch[]): string[] {
  return matches.map(
    (match) =>
      `Export scrubber: redacted ${match.count} ${match.patternName} match${match.count === 1 ? "" : "es"} at ${match.path}.`,
  );
}
