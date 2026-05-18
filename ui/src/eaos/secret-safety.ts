// Secret/PII sweep helpers used by the LET-181 shell tests.
//
// The validation contract requires that no `/eaos` label, route, breadcrumb,
// command-palette entry, page title, or static fixture leaks a raw secret,
// token, credential, connection string, or private destination identifier.
// These regex patterns are intentionally conservative — false positives are
// preferable to false negatives.

export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS secret access key", pattern: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i },
  { name: "GitHub personal access token", pattern: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub OAuth token", pattern: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub app token", pattern: /\bghu_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack bot/user token", pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "Generic bearer token in header", pattern: /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/ },
  { name: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "JWT-shaped token", pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
  {
    name: "Generic credential assignment",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?token|access[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}["']?/i,
  },
  {
    name: "DB connection string with credentials",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^\s/@]+@[^\s/]+/i,
  },
];

export interface SecretMatch {
  readonly source: string;
  readonly pattern: string;
  readonly match: string;
}

export function sweepForSecrets(values: readonly string[]): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      const found = value.match(pattern);
      if (found) {
        matches.push({ source: value, pattern: name, match: found[0] });
      }
    }
  }
  return matches;
}
