import { asBoolean, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type CursorCloudRepoEntry = {
  url: string;
  startingRef?: string;
  prUrl?: string;
};

export type CursorCloudAdapterConfig = {
  repoUrl?: string;
  repoStartingRef?: string;
  repoPullRequestUrl?: string;
  runtimeEnvType?: "cloud" | "pool" | "machine";
  runtimeEnvName?: string;
  executionTarget?: "cloud" | "pool" | "machine";
  environmentName?: string;
  repos?: CursorCloudRepoEntry[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  model?: string;
  mode?: "agent" | "plan";
  mcpServers?: Array<{
    name: string;
    transport?: "http" | "stdio";
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
  capabilities?: {
    chatMode?: boolean;
    multiRepo?: boolean;
    planMode?: boolean;
  };
  env?: Record<string, unknown>;
  promptTemplate?: string;
  bootstrapPromptTemplate?: string;
  instructionsFilePath?: string;
};

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseCursorCloudAdapterConfig(raw: unknown): CursorCloudAdapterConfig {
  const config = parseObject(raw) as Record<string, unknown>;
  const reposRaw = Array.isArray(config.repos) ? config.repos : [];
  const repos: CursorCloudRepoEntry[] = reposRaw
    .map((entry) => parseObject(entry))
    .map((entry) => ({
      url: asString(entry.url, "").trim(),
      startingRef: trimNullable(entry.startingRef) ?? undefined,
      prUrl: trimNullable(entry.prUrl) ?? undefined,
    }))
    .filter((entry) => entry.url.length > 0);

  return {
    repoUrl: trimNullable(config.repoUrl) ?? undefined,
    repoStartingRef: trimNullable(config.repoStartingRef) ?? undefined,
    repoPullRequestUrl: trimNullable(config.repoPullRequestUrl) ?? undefined,
    runtimeEnvType: trimNullable(config.runtimeEnvType) as CursorCloudAdapterConfig["runtimeEnvType"],
    runtimeEnvName: trimNullable(config.runtimeEnvName) ?? undefined,
    executionTarget: trimNullable(config.executionTarget) as CursorCloudAdapterConfig["executionTarget"],
    environmentName: trimNullable(config.environmentName) ?? undefined,
    repos: repos.length > 0 ? repos : undefined,
    workOnCurrentBranch: asBoolean(config.workOnCurrentBranch, false),
    autoCreatePR: asBoolean(config.autoCreatePR, false),
    skipReviewerRequest: asBoolean(config.skipReviewerRequest, false),
    model: trimNullable(config.model) ?? undefined,
    mode: config.mode === "plan" ? "plan" : config.mode === "agent" ? "agent" : undefined,
    mcpServers: Array.isArray(config.mcpServers)
      ? (config.mcpServers as CursorCloudAdapterConfig["mcpServers"])
      : undefined,
    capabilities: parseObject(config.capabilities) as CursorCloudAdapterConfig["capabilities"],
    env: parseObject(config.env) as Record<string, unknown>,
    promptTemplate: trimNullable(config.promptTemplate) ?? undefined,
    bootstrapPromptTemplate: trimNullable(config.bootstrapPromptTemplate) ?? undefined,
    instructionsFilePath: trimNullable(config.instructionsFilePath) ?? undefined,
  };
}

export function resolveExecutionTarget(config: CursorCloudAdapterConfig): {
  envType: "cloud" | "pool" | "machine";
  envName: string | null;
} {
  const envType = config.executionTarget ?? config.runtimeEnvType ?? "cloud";
  const normalized =
    envType === "pool" || envType === "machine" ? envType : ("cloud" as const);
  const envName = config.environmentName ?? config.runtimeEnvName ?? null;
  return { envType: normalized, envName: envName?.trim() || null };
}

export function resolveCursorCloudRepos(
  config: CursorCloudAdapterConfig,
  workspace: Record<string, unknown>,
): CursorCloudRepoEntry[] {
  if (config.repos?.length) return config.repos;
  const url = (config.repoUrl ?? asString(workspace.repoUrl, "")).trim();
  if (!url) return [];
  return [
    {
      url,
      startingRef: config.repoStartingRef ?? trimNullable(workspace.repoRef) ?? undefined,
      prUrl: config.repoPullRequestUrl ?? undefined,
    },
  ];
}
