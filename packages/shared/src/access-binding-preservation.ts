// Approved agent secret bindings live at `access.<ALIAS>` on adapterConfig.
// An adapter swap or other full config rewrite often omits those dynamic keys.
// Omission keeps the current binding. `null` removes it on purpose.

export const ACCESS_SECRET_BINDING_KEY = /^access\.[A-Za-z_][A-Za-z0-9_]*$/;

export function isAccessSecretBindingKey(key: string): boolean {
  return ACCESS_SECRET_BINDING_KEY.test(key);
}

function asConfig(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSecretBinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "secret_ref" || type === "user_secret_ref";
}

/** Copy omitted access bindings forward. Keep an explicit null so the caller can revoke. */
export function preserveOmittedAccessBindings(
  current: unknown,
  incoming: Record<string, unknown>,
  preserveOmitted = true,
): Record<string, unknown> {
  const currentConfig = asConfig(current) ?? {};
  const config: Record<string, unknown> = { ...incoming };
  if (preserveOmitted) {
    for (const [key, value] of Object.entries(currentConfig)) {
      if (!isAccessSecretBindingKey(key) || value == null) continue;
      if (Object.prototype.hasOwnProperty.call(incoming, key)) continue;
      config[key] = value;
    }
  }
  for (const key of Object.keys(config)) {
    if (isAccessSecretBindingKey(key) && config[key] === undefined) config[key] = null;
  }
  return config;
}

/** Mark access bindings that a full document dropped, so revocation stays explicit. */
export function tombstoneOmittedAccessBindings(
  current: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const currentConfig = asConfig(current) ?? {};
  const config: Record<string, unknown> = { ...incoming };
  for (const [key, value] of Object.entries(currentConfig)) {
    if (!isAccessSecretBindingKey(key) || value == null) continue;
    if (!Object.prototype.hasOwnProperty.call(config, key)) config[key] = null;
  }
  return config;
}

/**
 * Apply the persistence rule inside the locked agent update.
 * Omitted access bindings are copied from the locked row. Null removes them.
 */
export function finalizeAccessBindingConfig(
  current: unknown,
  incoming: Record<string, unknown>,
  preserveOmitted = true,
): { config: Record<string, unknown>; removedPaths: string[] } {
  const currentConfig = asConfig(current) ?? {};
  const config = preserveOmittedAccessBindings(currentConfig, incoming, preserveOmitted);
  const removedPaths: string[] = [];
  for (const key of Object.keys(config)) {
    if (!isAccessSecretBindingKey(key)) continue;
    if (config[key] != null) continue;
    if (currentConfig[key] != null) removedPaths.push(key);
    delete config[key];
  }
  removedPaths.sort();
  return { config, removedPaths };
}

/** Paths whose secret bindings the incoming config explicitly clears. Values are never included. */
export function explicitSecretBindingRemovals(
  current: unknown,
  incoming: unknown,
  options?: { envOmissionRemoves?: boolean },
): string[] {
  const currentConfig = asConfig(current) ?? {};
  const incomingConfig = asConfig(incoming);
  if (!incomingConfig) return [];
  const removed = new Set<string>();
  for (const [key, value] of Object.entries(currentConfig)) {
    if (!isAccessSecretBindingKey(key) || !isSecretBinding(value)) continue;
    if (!Object.prototype.hasOwnProperty.call(incomingConfig, key)) continue;
    if (incomingConfig[key] == null) removed.add(key);
  }
  const currentEnv = asConfig(currentConfig.env) ?? {};
  const envSecrets = Object.entries(currentEnv).filter(([, value]) => isSecretBinding(value));
  if (Object.prototype.hasOwnProperty.call(incomingConfig, "env")) {
    const nextEnv = asConfig(incomingConfig.env);
    if (!nextEnv) {
      for (const [key] of envSecrets) removed.add(`env.${key}`);
    } else {
      for (const [key] of envSecrets) {
        if (!Object.prototype.hasOwnProperty.call(nextEnv, key) || nextEnv[key] == null) {
          removed.add(`env.${key}`);
        }
      }
    }
  } else if (options?.envOmissionRemoves) {
    for (const [key] of envSecrets) removed.add(`env.${key}`);
  }
  return [...removed].sort();
}
