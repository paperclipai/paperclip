/**
 * Secret redaction — regex-based scrubbing applied before any output reaches
 * artifact storage or telemetry.
 *
 * Patterns cover: AWS keys, Bearer/API tokens, passwords, connection strings,
 * kubeconfig client certificates.
 */

interface RedactionPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

const PATTERNS: RedactionPattern[] = [
  // AWS access key IDs (20 uppercase alphanumeric starting with AKIA/ASIA/AROA/AIPA/ANPA/ANVA/APKA)
  {
    name: "aws_access_key_id",
    regex: /\b(A(?:KIA|SIA|ROA|IPA|NPA|NVA|PKA)[0-9A-Z]{16})\b/g,
    replacement: "[REDACTED:aws_key_id]",
  },
  // AWS secret access keys (40 base64-ish chars after known assignment patterns)
  {
    name: "aws_secret_key",
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*([A-Za-z0-9/+]{40})/gi,
    replacement: "AWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret]",
  },
  // Generic Bearer tokens
  {
    name: "bearer_token",
    regex: /Bearer\s+([A-Za-z0-9\-._~+/]{20,})/g,
    replacement: "Bearer [REDACTED:token]",
  },
  // Authorization headers
  {
    name: "authorization_header",
    regex: /(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s\r\n]{10,}/gi,
    replacement: "$1[REDACTED]",
  },
  // API keys in query strings or env-style assignments
  {
    name: "api_key_assignment",
    regex: /\b([A-Za-z_][A-Za-z0-9_]*(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key))\s*[=:]\s*['"]?([A-Za-z0-9\-._~+/!@#$%^&*]{16,}?)['"]?(?=[\s,;}\r\n]|$)/gi,
    replacement: "$1=[REDACTED:secret]",
  },
  // Password assignments
  {
    name: "password",
    regex: /\b(password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"\r\n]{4,})['"]?/gi,
    replacement: "$1=[REDACTED:password]",
  },
  // Connection strings with embedded credentials (postgres://, mysql://, mongodb://)
  {
    name: "db_connection_string",
    regex: /([a-z][a-z0-9+.-]*:\/\/)[^:@\s]+:[^@\s]+(@[^\s]+)/gi,
    replacement: "$1[REDACTED:credentials]$2",
  },
  // Kubeconfig client-certificate-data / client-key-data (base64 blobs)
  {
    name: "kubeconfig_cert",
    regex: /(client-(?:certificate|key)-data:\s+)[A-Za-z0-9+/=\r\n\t ]{40,}/g,
    replacement: "$1[REDACTED:cert]",
  },
  // Private key PEM blocks
  {
    name: "pem_private_key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
    replacement: "[REDACTED:private_key]",
  },
  // GitHub / GitLab tokens
  {
    name: "github_token",
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g,
    replacement: "[REDACTED:github_token]",
  },
  // Slack bot/user tokens
  {
    name: "slack_token",
    regex: /\b(xox[baepc]-[A-Za-z0-9\-]{10,})\b/g,
    replacement: "[REDACTED:slack_token]",
  },
];

/** Apply all redaction patterns to a string. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    // Reset lastIndex for global regexes between calls
    pattern.regex.lastIndex = 0;
    result = result.replace(pattern.regex, pattern.replacement);
  }
  return result;
}

/** Redact secrets in an arbitrary JSON-serializable value (deep). */
export function redactSecretsInValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsInValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsInValue(v);
    }
    return out;
  }
  return value;
}
