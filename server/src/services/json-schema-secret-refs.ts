const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export type SecretRefBindingObject = {
  secretId: string;
  version: "latest" | number;
};

/**
 * Parses the `{ type: "secret_ref", secretId, version? }` binding object that
 * secret pickers submit for `format: "secret-ref"` config fields. Returns null
 * for anything else (raw values, bare secret-id strings, malformed objects).
 */
export function parseSecretRefBindingObject(value: unknown): SecretRefBindingObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  if (typeof record.secretId !== "string" || !isUuidSecretRef(record.secretId.trim())) return null;
  const version = record.version;
  if (version === undefined || version === null || version === "latest") {
    return { secretId: record.secretId.trim(), version: "latest" };
  }
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { secretId: record.secretId.trim(), version };
  }
  return null;
}

export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        walk(branch as Record<string, unknown>, prefix);
      }
    }

    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== "object") return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propertySchema.format === "secret-ref") {
        paths.add(path);
      }
      walk(propertySchema, path);
    }
  }

  walk(schema, "");
  return paths;
}

export function readConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = config;
  for (const key of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function writeConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = structuredClone(config) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let cursor: Record<string, unknown> = result;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const leafKey = keys[keys.length - 1]!;
  if (value === undefined) {
    delete cursor[leafKey];
  } else {
    cursor[leafKey] = value;
  }
  return result;
}
