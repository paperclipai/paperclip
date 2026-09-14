// Shared parser for the agent configuration form environment fields.
//
// The form supplies two sources for adapter `env`:
//   - `envBindings`: structured bindings keyed by variable name. A binding is a
//     plain value, a company `secret_ref`, or a user-scoped `user_secret_ref`.
//   - `envVars`: a legacy plain-text block of `KEY=value` lines.
//
// The server resolves every binding to a string, both at run time and at test
// time. This parser must keep each binding shape intact so the resolver gets
// it. A dropped binding makes the agent "Test" action miss a variable that a
// real run receives. So this parser keeps all three binding types. It never
// resolves a secret and never reads a secret value; it only preserves the
// binding shape for the server resolver.

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isVersionSelector(value: unknown): value is number | "latest" {
  return typeof value === "number" || value === "latest";
}

/**
 * Convert the structured `envBindings` map into an adapter `env` map. Keep
 * `plain`, `secret_ref`, and `user_secret_ref` bindings. Drop entries with an
 * invalid variable name or an unknown binding shape.
 */
export function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(isVersionSelector(rec.version) ? { version: rec.version } : {}),
      };
      continue;
    }
    if (rec.type === "user_secret_ref" && typeof rec.key === "string") {
      env[key] = {
        type: "user_secret_ref",
        key: rec.key,
        ...(isVersionSelector(rec.version) ? { version: rec.version } : {}),
        ...(typeof rec.required === "boolean" ? { required: rec.required } : {}),
        ...(typeof rec.allowMissingOverride === "boolean"
          ? { allowMissingOverride: rec.allowMissingOverride }
          : {}),
      };
    }
  }
  return env;
}

/**
 * Parse the legacy plain-text `KEY=value` block. Skip blank lines, comment
 * lines, and lines with an invalid variable name.
 */
export function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!ENV_KEY_RE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Build the adapter `env` map from both form sources. A structured binding wins
 * over a legacy plain-text entry with the same key.
 */
export function buildAdapterEnvConfig(
  envBindings: unknown,
  envVars: string | undefined | null,
): Record<string, unknown> {
  const env = parseEnvBindings(envBindings);
  const legacy = parseEnvVars(envVars ?? "");
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  return env;
}
