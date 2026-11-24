import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectWorkspaceRuntimeCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  for (const collectionKey of ["commands", "services", "jobs"] as const) {
    const entries = raw[collectionKey];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (isRecord(entry) && hasOwn(entry, "command")) {
        paths.push(`${prefixPath(prefix, collectionKey)}[${index}].command`);
      }
    });
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "runtimeProvisionCommand")) {
    paths.push(prefixPath(prefix, "runtimeProvisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  paths.push(
    ...collectWorkspaceRuntimeCommandPaths(
      raw.workspaceRuntime,
      prefixPath(prefix, "workspaceRuntime"),
    ),
  );
  return paths;
}

/**
 * Adapter-config keys that let a caller steer host execution (host commands,
 * working directory, environment, sandbox command) or point the server at a
 * host filesystem path. Agent keys must never set them — on the agent itself
 * (see assertNoAgentLocalAdapterHostCommandMutation) or through a task's
 * assigneeAdapterOverrides (see collectIssueWorkspaceCommandPaths). Operators
 * may still set them: e.g. the agy_local skillsRootPath override
 * (/srv/agy-skills) is a host path the server-side skill sync writes under
 * (mkdir/symlink), so an agent key must never be able to point it at an
 * arbitrary host location.
 */
export const LOCAL_ADAPTER_HOST_COMMAND_KEYS = [
  "command",
  "hermesCommand",
  "args",
  "extraArgs",
  "cwd",
  "env",
  "filesystemSandboxCommand",
  "skillsRootPath",
] as const;

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return [
    ...collectWorkspaceStrategyCommandPaths(
      policy.workspaceStrategy,
      "executionWorkspacePolicy.workspaceStrategy",
    ),
    ...collectWorkspaceRuntimeCommandPaths(
      policy.workspaceRuntime,
      "executionWorkspacePolicy.workspaceRuntime",
    ),
  ];
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths = hasOwn(workspacePatch, "cleanupCommand")
    ? [prefixPath(prefix, "cleanupCommand")]
    : [];
  if (isRecord(workspacePatch.runtimeConfig)) {
    paths.push(
      ...collectWorkspaceRuntimeCommandPaths(
        workspacePatch.runtimeConfig.workspaceRuntime,
        prefixPath(prefix, "runtimeConfig.workspaceRuntime"),
      ),
    );
  }
  return paths;
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
    paths.push(
      ...collectWorkspaceRuntimeCommandPaths(
        input.executionWorkspaceSettings.workspaceRuntime,
        "executionWorkspaceSettings.workspaceRuntime",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
      // Task-level adapter overrides merge into the assignee's adapter config
      // at run time, so an agent key must not smuggle host-command keys
      // through them either (e.g. skillsRootPath would let the server-side
      // agy skill sync mkdir/symlink under an arbitrary host path).
      // Operators may still set these on a task; the gate above only fires
      // for agent actors.
      for (const key of LOCAL_ADAPTER_HOST_COMMAND_KEYS) {
        if (hasOwn(adapterConfig, key)) {
          paths.push(`assigneeAdapterOverrides.adapterConfig.${key}`);
        }
      }
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}
