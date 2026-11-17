/** New admissions are qualified locally for isolated native Codex. Saved runs
 * retain their admitted representation even when the rollout flag changes. */
export function sharedSkillRepositoryLayout(input: { native: boolean; backend: string | null | (() => string); environmentDriver?: string | null;
  homeMode?: unknown; enabled: boolean; persistedExecution?: unknown }): "shared" | undefined {
  if (input.persistedExecution && typeof input.persistedExecution === "object") {
    const saved = input.persistedExecution as { schema?: string; runtimeContext?: { skills?: Array<{ repository?: unknown }> } };
    return saved.schema === "paperclip.native-execution-input.v12" && saved.runtimeContext?.skills?.some(skill => skill.repository) ? "shared" : undefined;
  }
  if (!input.enabled || !input.native || input.homeMode === "preconfigured"
    || (input.environmentDriver && input.environmentDriver !== "local")) return undefined;
  return (typeof input.backend === "function" ? input.backend() : input.backend) === "codex_app_server" ? "shared" : undefined;
}
