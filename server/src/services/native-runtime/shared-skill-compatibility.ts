/** New admissions are qualified locally for isolated native Codex. Saved runs
 * retain their admitted representation even when the rollout flag changes. */
export function sharedSkillRepositoryLayout(input: { native: boolean; backend: string | null; environmentDriver?: string | null;
  homeMode?: unknown; enabled: boolean; persistedExecution?: unknown }): "shared" | undefined {
  if (input.persistedExecution && typeof input.persistedExecution === "object") {
    const saved = input.persistedExecution as { schema?: string; runtimeContext?: { skills?: Array<{ repository?: unknown }> } };
    return saved.schema === "paperclip.native-execution-input.v12" && saved.runtimeContext?.skills?.some(skill => skill.repository) ? "shared" : undefined;
  }
  return input.enabled && input.native && input.backend === "codex_app_server" && input.homeMode !== "preconfigured"
    && (!input.environmentDriver || input.environmentDriver === "local") ? "shared" : undefined;
}
