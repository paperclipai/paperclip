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
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  // workspaceRuntime carries jobs/commands/services arrays that execute on the host.
  // Treat the entire key as a blocked path so agents cannot inject arbitrary commands
  // that are later triggered via the /run endpoint.
  if (hasOwn(raw, "workspaceRuntime")) {
    paths.push(prefixPath(prefix, "workspaceRuntime"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(adapterConfig: unknown): string[] {
  if (!isRecord(adapterConfig)) return [];
  const paths = collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    "adapterConfig.workspaceStrategy",
  );
  if (hasOwn(adapterConfig, "workspaceRuntime")) {
    paths.push("adapterConfig.workspaceRuntime");
  }
  return paths;
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  const paths = collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
  if (hasOwn(policy, "workspaceRuntime")) {
    paths.push("executionWorkspacePolicy.workspaceRuntime");
  }
  return paths;
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths: string[] = [];
  if (hasOwn(workspacePatch, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  // workspaceRuntime is stored nested under runtimeConfig in project workspace metadata
  if (isRecord(workspacePatch.runtimeConfig) && hasOwn(workspacePatch.runtimeConfig, "workspaceRuntime")) {
    paths.push(prefixPath(prefix, "runtimeConfig.workspaceRuntime"));
  }
  // workspaceRuntime can also be injected via the free-form metadata field because
  // the service reads metadata.runtimeConfig.workspaceRuntime via
  // readProjectWorkspaceRuntimeConfig — block that path explicitly.
  if (
    isRecord(workspacePatch.metadata) &&
    isRecord(workspacePatch.metadata.runtimeConfig) &&
    hasOwn(workspacePatch.metadata.runtimeConfig, "workspaceRuntime")
  ) {
    paths.push(prefixPath(prefix, "metadata.runtimeConfig.workspaceRuntime"));
  }
  return paths;
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    if (hasOwn(input.executionWorkspaceSettings, "workspaceRuntime")) {
      paths.push("executionWorkspaceSettings.workspaceRuntime");
    }
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      if (hasOwn(adapterConfig, "workspaceRuntime")) {
        paths.push("assigneeAdapterOverrides.adapterConfig.workspaceRuntime");
      }
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
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
