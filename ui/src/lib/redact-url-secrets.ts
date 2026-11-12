const REDACTED_URL_VALUE = "REDACTED";

const SENSITIVE_URL_FIELD_PATTERN =
  String.raw`(?:code|state|nonce|key|[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*)`;
const SENSITIVE_URL_FIELD_RE = new RegExp(`^${SENSITIVE_URL_FIELD_PATTERN}$`, "i");

function redactSearchParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (!SENSITIVE_URL_FIELD_RE.test(key)) continue;
    params.set(key, REDACTED_URL_VALUE);
    changed = true;
  }
  return changed;
}

function redactUrlHash(url: URL) {
  const hash = url.hash.slice(1);
  if (!hash.includes("=")) return;

  const params = new URLSearchParams(hash);
  if (redactSearchParams(params)) url.hash = params.toString();
}

function redactUrlUserInfo(url: URL) {
  if (!url.username && !url.password) return;
  url.username = REDACTED_URL_VALUE;
  url.password = "";
}

function redactUrlWithParser(value: string): string | null {
  try {
    const url = new URL(value);
    redactUrlUserInfo(url);
    redactSearchParams(url.searchParams);
    redactUrlHash(url);
    return url.toString();
  } catch {
    return null;
  }
}

function redactUrlWithFallback(value: string): string {
  const secretAssignment = new RegExp(
    `([?&#;]\\s*${SENSITIVE_URL_FIELD_PATTERN}\\s*=)[^&#;\\s]*`,
    "gi",
  );
  return value.replace(secretAssignment, `$1${REDACTED_URL_VALUE}`);
}

export function redactUrlSecrets(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  return redactUrlWithParser(trimmed) ?? redactUrlWithFallback(value);
}
