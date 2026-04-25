const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /pk_test_[A-Za-z0-9]{20,}/gi, replacement: "pk_test_***REDACTED***" },
  { pattern: /sk_test_[A-Za-z0-9]{20,}/gi, replacement: "sk_test_***REDACTED***" },
  { pattern: /whsec_[A-Za-z0-9]{20,}/gi, replacement: "whsec_***REDACTED***" },
  { pattern: /gho_[A-Za-z0-9]{20,}/gi, replacement: "gho_***REDACTED***" },
  { pattern: /sk_live_[A-Za-z0-9]{20,}/gi, replacement: "sk_live_***REDACTED***" },
  { pattern: /rk_live_[A-Za-z0-9]{20,}/gi, replacement: "rk_live_***REDACTED***" },
  { pattern: /sq_live_[A-Za-z0-9]{20,}/gi, replacement: "sq_live_***REDACTED***" },
  { pattern: /sk_[A-Za-z0-9_-]{20,}/gi, replacement: "sk_***REDACTED***" },
  { pattern: /token_[A-Za-z0-9_-]{20,}/gi, replacement: "token_***REDACTED***" },
  { pattern: /xoxb-[A-Za-z0-9-]{20,}/gi, replacement: "xoxb-***REDACTED***" },
  { pattern: /xoxp-[A-Za-z0-9-]{20,}/gi, replacement: "xoxp-***REDACTED***" },
  { pattern: /AIza[A-Za-z0-9_-]{20,}/gi, replacement: "AIza***REDACTED***" },
  { pattern: /AKIA[A-Z0-9]{16}/gi, replacement: "AKIA***REDACTED***" },
  { pattern: /[A-Za-z0-9_-]{20,}__(?:secret|token|key|password|credential)/gi, replacement: "***REDACTED***" },
  { pattern: /(?:password|secret|token|key|credential)\s*[:=]\s*['"]?([A-Za-z0-9_-]{8,})['"]?/gi, replacement: "$1: ***REDACTED***" },
];

const JWT_VALUE_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BASE64_SECRET_RE = /['"][A-Za-z0-9+/=]{40,}['"]/g;

export const REDACTED_OUTPUT_VALUE = "***REDACTED***";

export function scrubSecretValues(input: string): string {
  if (!input || typeof input !== "string") return input;

  let result = input;

  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  result = result.replace(JWT_VALUE_RE, "***JWT***REDACTED***");

  result = result.replace(BASE64_SECRET_RE, (match) => {
    if (match.length > 50) {
      return "***BASE64_SECRET_REDACTED***";
    }
    return match;
  });

  return result;
}

export function scrubOutputWithPatterns(
  input: string,
  additionalPatterns: Array<{ pattern: RegExp; replacement: string }> = [],
): string {
  let result = scrubSecretValues(input);

  for (const { pattern, replacement } of additionalPatterns) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

export function createOutputScrubber(knownSecretValues: string[] = []) {
  const secretReplacements: Array<{ pattern: RegExp; replacement: string }> = knownSecretValues
    .filter((v) => typeof v === "string" && v.length > 3)
    .map((value) => ({
      pattern: new RegExp(escapeRegExp(value), "g"),
      replacement: REDACTED_OUTPUT_VALUE,
    }));

  return function scrub(text: string): string {
    let result = scrubOutputWithPatterns(text, secretReplacements);
    return result;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ScrubberOptions {
  knownSecretValues?: string[];
  additionalPatterns?: Array<{ pattern: RegExp; replacement: string }>;
}

export function createStructuredOutputScrubber(opts: ScrubberOptions = {}) {
  const { knownSecretValues = [], additionalPatterns = [] } = opts;

  const secretReplacements: Array<{ pattern: RegExp; replacement: string }> = knownSecretValues
    .filter((v) => typeof v === "string" && v.length > 3)
    .map((value) => ({
      pattern: new RegExp(escapeRegExp(value), "g"),
      replacement: REDACTED_OUTPUT_VALUE,
    }));

  const allPatterns = [...secretReplacements, ...additionalPatterns];

  return function scrub(value: unknown): unknown {
    if (typeof value === "string") {
      let result = value;
      for (const { pattern, replacement } of allPatterns) {
        result = result.replace(pattern, replacement);
      }
      result = scrubSecretValues(result);
      return result;
    }

    if (Array.isArray(value)) {
      return value.map((item) => scrub(item));
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(record)) {
        redacted[key] = scrub(val);
      }
      return redacted;
    }

    return value;
  };
}