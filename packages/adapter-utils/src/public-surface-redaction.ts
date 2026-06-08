import { createHash } from "node:crypto";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "authorization",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

const CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_FIELD_NAME_PATTERN}(?:\s+|=)(["']?))([^\s"'` + "`" + String.raw`]+)(\2)`,
  "gi",
);
const ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_FIELD_NAME_PATTERN}\s*=\s*)(?:(["'])([^"'` + "`" + String.raw`\r\n]*)\2|([^\s"'` + "`" + String.raw`]+))`,
  "gi",
);
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))([^"'` + "`" + String.raw`\r\n]+)((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))([^\\\r\n]+)((?:\\"))`,
  "gi",
);
const AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)([^\s"'`]+)/gi;
const OPENAI_KEY_RE = /\b(sk-[A-Za-z0-9_-]{12,})\b/g;
const GITHUB_TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g;
const JWT_RE = /\b([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?)\b/g;

export type PublicSurfaceRedactionMatch = {
  kind: string;
  sha256Prefix: string;
};

export type PublicSurfaceRedactionResult = {
  text: string;
  redacted: boolean;
  matches: PublicSurfaceRedactionMatch[];
};

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function sha256Prefix(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function redactValue(kind: string, value: string, matches: PublicSurfaceRedactionMatch[]) {
  matches.push({ kind, sha256Prefix: sha256Prefix(value) });
  return `[REDACTED:${kind}:${sha256Prefix(value)}]`;
}

function appendMarker(text: string, matches: PublicSurfaceRedactionMatch[]) {
  if (matches.length === 0) return text;
  return `${text}\n[value present, was redacted before public post]`;
}

export function redactPublicSurfaceText(
  input: string,
  opts: { appendMarker?: boolean } = {},
): PublicSurfaceRedactionResult {
  if (!maybeContainsSecretText(input)) {
    return { text: input, redacted: false, matches: [] };
  }

  const matches: PublicSurfaceRedactionMatch[] = [];
  let text = input
    .replace(AUTHORIZATION_BEARER_RE, (_match, prefix: string, value: string) => {
      return `${prefix}${redactValue("bearer-token", value, matches)}`;
    })
    .replace(CLI_SECRET_OPTION_RE, (_match, prefix: string, quote: string, value: string, suffix: string) => {
      return `${prefix}${redactValue("secret", value, matches)}${suffix ?? quote ?? ""}`;
    })
    .replace(ENV_SECRET_ASSIGNMENT_RE, (_match, prefix: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const value = quoted ?? bare ?? "";
      const replacement = redactValue("secret", value, matches);
      return quote ? `${prefix}${quote}${replacement}${quote}` : `${prefix}${replacement}`;
    })
    .replace(JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, value: string, suffix: string) => {
      return `${prefix}${redactValue("secret", value, matches)}${suffix}`;
    })
    .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, (_match, prefix: string, value: string, suffix: string) => {
      return `${prefix}${redactValue("secret", value, matches)}${suffix}`;
    })
    .replace(OPENAI_KEY_RE, (_match, value: string) => redactValue("secret", value, matches))
    .replace(GITHUB_TOKEN_RE, (_match, value: string) => redactValue("secret", value, matches))
    .replace(JWT_RE, (_match, value: string) => redactValue("jwt", value, matches));

  if (opts.appendMarker !== false) {
    text = appendMarker(text, matches);
  }

  return {
    text,
    redacted: matches.length > 0,
    matches,
  };
}
