import type { ProjectEnvBindingMetadata, ProjectEnvMetadata } from "@paperclipai/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readVersion(value: unknown): number | "latest" | undefined {
  return value === "latest" || (typeof value === "number" && Number.isInteger(value) && value > 0)
    ? value
    : undefined;
}

function bindingMetadata(binding: unknown): ProjectEnvBindingMetadata {
  if (typeof binding === "string") {
    return { type: "plain", configured: true };
  }
  if (!isRecord(binding)) {
    return { type: "unknown", configured: true };
  }
  if (binding.type === "plain") {
    return { type: "plain", configured: true };
  }
  if (binding.type === "secret_ref") {
    const version = readVersion(binding.version);
    return {
      type: "secret_ref",
      configured: true,
      ...(typeof binding.secretId === "string" ? { secretId: binding.secretId } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(typeof binding.projectionClass === "string"
        ? { projectionClass: binding.projectionClass }
        : {}),
      ...(typeof binding.projectionAllowlistKey === "string" || binding.projectionAllowlistKey === null
        ? { projectionAllowlistKey: binding.projectionAllowlistKey }
        : {}),
    };
  }
  if (binding.type === "user_secret_ref") {
    const version = readVersion(binding.version);
    return {
      type: "user_secret_ref",
      configured: true,
      ...(typeof binding.key === "string" ? { key: binding.key } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(typeof binding.required === "boolean" ? { required: binding.required } : {}),
      ...(typeof binding.allowMissingOverride === "boolean"
        ? { allowMissingOverride: binding.allowMissingOverride }
        : {}),
    };
  }
  return { type: "unknown", configured: true };
}

export function projectEnvMetadata(env: unknown): ProjectEnvMetadata | null {
  if (!isRecord(env)) return null;
  const keys = Object.keys(env).sort();
  return {
    keys,
    bindings: Object.fromEntries(keys.map((key) => [key, bindingMetadata(env[key])])),
  };
}

/**
 * Project environment values are write-only control-plane inputs. Read and
 * mutation responses expose binding metadata, while runtime resolution remains
 * inside the authorized heartbeat execution path.
 */
export function projectForApi<T extends { env?: unknown }>(project: T) {
  return {
    ...project,
    env: null,
    envMetadata: projectEnvMetadata(project.env),
  };
}
