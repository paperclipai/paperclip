const REDACTED_URL_VALUE = "REDACTED";

const SENSITIVE_URL_FIELD_PATTERN =
  /^(?:code|state|nonce|key|[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*)$/i;

export const REMOTE_URL_SECRET_CONFIG_PATH = "remote.url";

export interface SplitRemoteUrlCredential {
  publicUrl: string;
  secretUrl: string | null;
  secretParameterNames: string[];
}

/**
 * Separate credential-bearing query values from the URL that is safe to store
 * on a tool connection. The complete URL is written to the encrypted vault;
 * only its public origin, path, and non-sensitive query configuration remain
 * in connection config and API responses.
 */
export function splitRemoteUrlCredential(value: string): SplitRemoteUrlCredential {
  const input = value.trim();
  const url = new URL(input);
  const hasUserInfo = url.username.length > 0 || url.password.length > 0;
  if (hasUserInfo) {
    url.username = "";
    url.password = "";
  }
  const secretParameterNames: string[] = [];
  for (const key of [...url.searchParams.keys()]) {
    if (!SENSITIVE_URL_FIELD_PATTERN.test(key)) continue;
    secretParameterNames.push(key);
    url.searchParams.delete(key);
  }
  return {
    publicUrl: url.toString(),
    secretUrl: hasUserInfo || secretParameterNames.length > 0 ? input : null,
    secretParameterNames,
  };
}

/** Preserve useful endpoint context in logs without retaining credentials. */
export function redactRemoteUrlCredential(value: string): string {
  const input = value.trim();
  try {
    const url = new URL(input);
    if (url.username || url.password) {
      url.username = REDACTED_URL_VALUE;
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_FIELD_PATTERN.test(key)) url.searchParams.set(key, REDACTED_URL_VALUE);
    }
    return url.toString();
  } catch {
    return "configured remote MCP endpoint";
  }
}

/**
 * A vault value may be replaced independently of connection config. Keep that
 * replacement constrained to the public endpoint the operator originally
 * reviewed; only credential-bearing query values may differ.
 */
export function remoteUrlCredentialMatchesPublicUrl(publicValue: string, secretValue: string): boolean {
  try {
    return splitRemoteUrlCredential(secretValue).publicUrl === new URL(publicValue).toString();
  } catch {
    return false;
  }
}
