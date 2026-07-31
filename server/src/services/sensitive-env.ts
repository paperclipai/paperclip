const SENSITIVE_ENV_KEY_PARTS = [
  "apikey",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "authheader",
  "auth_header",
  "auth-header",
  "auth_token",
  "auth-token",
  "authorization",
  "bearer",
  "secret",
  "passwd",
  "password",
  "credential",
  "jwt",
  "privatekey",
  "private_key",
  "private-key",
  "cookie",
  "connectionstring",
  "connection_string",
  "connection-string",
] as const;

export function isSensitiveEnvKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    normalized.endsWith("token") ||
    normalized === "pat" ||
    normalized.endsWith("_pat") ||
    normalized.endsWith("-pat") ||
    normalized.endsWith("auth") ||
    normalized === "database_url" ||
    normalized.endsWith("_database_url") ||
    normalized.endsWith("-database-url") ||
    (normalized.includes("posthog") && normalized.endsWith("_scope")) ||
    SENSITIVE_ENV_KEY_PARTS.some((part) => normalized.includes(part))
  );
}
