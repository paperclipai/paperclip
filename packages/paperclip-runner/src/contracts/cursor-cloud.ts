export const CURSOR_CLOUD_DEFAULT_TIMEOUT_MS = 900_000;
export const CURSOR_CLOUD_CANCEL_TIMEOUT_MS = 20_000;
export const CURSOR_CLOUD_TERMINAL_DRAIN_TIMEOUT_MS = CURSOR_CLOUD_CANCEL_TIMEOUT_MS + 10_000;

export interface NativeCursorCloudConfig {
  schema: "paperclip.cursor-cloud.config.v1";
  repos: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  env?: { type: "cloud"; name?: string };
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  timeoutMs?: number;
}

export function parseNativeCursorCloudConfig(value: unknown): NativeCursorCloudConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cursor_cloud_config_invalid");
  const config = value as Record<string, unknown>;
  const allowed = new Set(["schema", "repos", "env", "workOnCurrentBranch", "autoCreatePR", "skipReviewerRequest", "timeoutMs"]);
  if (Object.keys(config).some(key => !allowed.has(key)) || config.schema !== "paperclip.cursor-cloud.config.v1"
    || !Array.isArray(config.repos) || config.repos.length > 16) throw new Error("cursor_cloud_config_invalid");
  const validText = (text: unknown) => typeof text === "string" && text.length > 0 && text.length <= 2048 && !/[\x00-\x1f\x7f]/.test(text);
  const repos = config.repos.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cursor_cloud_repository_invalid");
    const repo = value as Record<string, unknown>;
    if (Object.keys(repo).some(key => !["url", "startingRef", "prUrl"].includes(key)) || !validText(repo.url)
      || (repo.startingRef !== undefined && !validText(repo.startingRef)) || (repo.prUrl !== undefined && !validText(repo.prUrl))) {
      throw new Error("cursor_cloud_repository_invalid");
    }
    const url = new URL(repo.url as string);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("cursor_cloud_repository_invalid");
    return { url: repo.url as string, ...(repo.startingRef !== undefined ? { startingRef: repo.startingRef as string } : {}), ...(repo.prUrl !== undefined ? { prUrl: repo.prUrl as string } : {}) };
  });
  let env: NativeCursorCloudConfig["env"];
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) throw new Error("cursor_cloud_environment_invalid");
    const candidate = config.env as Record<string, unknown>;
    if (Object.keys(candidate).some(key => !["type", "name"].includes(key)) || candidate.type !== "cloud" || (candidate.name !== undefined && !validText(candidate.name))) throw new Error("cursor_cloud_environment_invalid");
    env = { type: "cloud", ...(candidate.name ? { name: candidate.name as string } : {}) };
  }
  if (repos.length && env?.name) throw new Error("cursor_cloud_repository_and_named_environment_are_exclusive");
  if (!repos.length && !env?.name) throw new Error("cursor_cloud_repository_or_environment_required");
  for (const key of ["workOnCurrentBranch", "autoCreatePR", "skipReviewerRequest"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") throw new Error("cursor_cloud_config_invalid");
  }
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || Number(config.timeoutMs) < 1000 || Number(config.timeoutMs) > 3_600_000)) throw new Error("cursor_cloud_timeout_invalid");
  return { schema: "paperclip.cursor-cloud.config.v1", repos, ...(env ? { env } : {}),
    ...(config.workOnCurrentBranch !== undefined ? { workOnCurrentBranch: config.workOnCurrentBranch as boolean } : {}),
    ...(config.autoCreatePR !== undefined ? { autoCreatePR: config.autoCreatePR as boolean } : {}),
    ...(config.skipReviewerRequest !== undefined ? { skipReviewerRequest: config.skipReviewerRequest as boolean } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs as number } : {}) };
}
