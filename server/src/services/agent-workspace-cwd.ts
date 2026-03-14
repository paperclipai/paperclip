import path from "node:path";
import { resolveDefaultAgentWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

const LOCAL_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

const KNOWN_INSTRUCTIONS_PATH_KEYS = ["instructionsFilePath", "agentsMdPath"] as const;
const WORKSPACES_ROOT = path.resolve(resolvePaperclipInstanceRoot(), "workspaces");

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isPaperclipFallbackWorkspaceCwd(input: {
  cwd: string | null | undefined;
  agentId?: string | null;
}): boolean {
  const cwd = readNonEmptyString(input.cwd);
  if (!cwd) return false;
  const resolvedCwd = path.resolve(cwd);
  if (input.agentId && resolvedCwd === path.resolve(resolveDefaultAgentWorkspaceDir(input.agentId))) {
    return true;
  }
  return resolvedCwd === WORKSPACES_ROOT || resolvedCwd.startsWith(`${WORKSPACES_ROOT}${path.sep}`);
}

export function preferProjectPrimaryWorkspaceCwd(input: {
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown>;
  projectPrimaryWorkspaceCwd: string | null | undefined;
  agentId?: string | null;
}): Record<string, unknown> {
  if (!LOCAL_ADAPTER_TYPES.has(readNonEmptyString(input.adapterType) ?? "")) {
    return input.adapterConfig;
  }

  const currentCwd = readNonEmptyString(input.adapterConfig.cwd);
  const projectPrimaryWorkspaceCwd = readNonEmptyString(input.projectPrimaryWorkspaceCwd);
  if (!currentCwd || !projectPrimaryWorkspaceCwd) {
    return input.adapterConfig;
  }
  if (
    !isPaperclipFallbackWorkspaceCwd({
      cwd: currentCwd,
      agentId: input.agentId,
    })
  ) {
    return input.adapterConfig;
  }
  if (path.resolve(currentCwd) === path.resolve(projectPrimaryWorkspaceCwd)) {
    return input.adapterConfig;
  }

  const nextConfig: Record<string, unknown> = {
    ...input.adapterConfig,
    cwd: projectPrimaryWorkspaceCwd,
  };
  for (const key of KNOWN_INSTRUCTIONS_PATH_KEYS) {
    const candidate = readNonEmptyString(input.adapterConfig[key]);
    if (candidate && !path.isAbsolute(candidate)) {
      nextConfig[key] = path.resolve(currentCwd, candidate);
    }
  }

  return nextConfig;
}
