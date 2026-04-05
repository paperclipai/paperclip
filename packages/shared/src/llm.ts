export function resolveZaiModelsEndpoint(envUrl?: string | null): string {
  return envUrl ? `${envUrl.replace(/\/$/, "")}/models` : "https://api.z.ai/api/paas/v4/models";
}
