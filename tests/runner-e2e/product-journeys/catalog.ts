import { agentJourneyRuns } from "./success-contract.js";
export { agentJourneyRuns } from "./success-contract.js";
import type { JourneyId, TargetConfig } from "./types.js";
export const productJourneys = [
  { id: "task-create", label: "Create a task for yourself and reopen it", requires: ["company", "board-user", "task-write"], capabilities: ["tasks/create"], paid: false },
  { id: "ask-question", label: "Ask an agent a question and read its answer", requires: ["company", "board-user", "task-write", "agent"], capabilities: ["questions-and-approvals/questions"], paid: true },
  { id: "task-properties", label: "Assign a task to the signed-in user", requires: ["company", "board-user", "task-write", "backlog-task"], capabilities: ["tasks/properties"], paid: false },
  { id: "plan-revise-accept", label: "Revise and approve a saved Plan, then complete the task", requires: ["company", "board-user", "task-write", "agent"], capabilities: ["questions-and-approvals/plan-review"], paid: true },
  { id: "build-revise", label: "Download and independently verify both artifact versions", requires: ["company", "board-user", "task-write", "agent"], capabilities: ["documents-artifacts/attachments"], paid: true },
  { id: "protected-actions", label: "Approve and decline protected service actions", requires: ["company", "board-user", "task-write", "agent", "review-service"], capabilities: ["questions-and-approvals/tool-review"], paid: true },
  { id: "create-skill-studio", label: "Create a company skill and persist a Skill Studio edit", requires: ["company", "board-user", "task-write", "agent", "skill-write"], capabilities: ["skills/authoring"], paid: true },
  { id: "stop-redirect", label: "Stop active work and send a new direction once", requires: ["company", "board-user", "task-write", "agent"], capabilities: ["steering/stop-and-pause"], paid: true },
  { id: "cloud-onboarding", label: "Create a Cloud workspace and complete a first task", requires: ["cloud-account", "fresh-workspace", "provider-key"], capabilities: ["onboarding/first-task"], paid: true },
] as const;

export function isAgentJourney(id: JourneyId): id is keyof typeof agentJourneyRuns { return Object.hasOwn(agentJourneyRuns, id); }

export function preparationPreview(config: TargetConfig) {
  return {
    target: { id: config.id, mode: config.mode, executionEnvironment: config.executionEnvironment },
    journeys: config.journeys.map(id => productJourneys.find(journey => journey.id === id)!),
    configuration: config.baseline,
    lifetime: config.mode === "existing-cloud" ? "persistent; clean run-owned resources only" : config.mode === "new-cloud" ? "disposable; delete on pass, retain failures up to 24 hours" : "managed instance; remove after every attempt",
    limits: config.limits, authentication: config.mode === "managed-self-hosted" ? "local-trusted" : "normal email-code sign-in",
    modelProfileId: config.modelProfileId ?? null,
    maxDisposableStacks: config.mode === "new-cloud" ? 1 : 0,
    retries: 0,
  };
}

export function parseTargetConfig(value: unknown): TargetConfig {
  const c = value as TargetConfig;
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
  if (!object(value) || Object.keys(value).some(key => !["version", "id", "mode", "adapterModule", "adapterConfig", "journeys", "executionEnvironment", "baseline", "limits", "headed", "modelProfileId"].includes(key))) throw new Error("invalid_target_configuration_fields");
  if (!c || c.version !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(c.id) ||
      !["managed-self-hosted", "existing-cloud", "new-cloud"].includes(c.mode) ||
      !["local", "daytona"].includes(c.executionEnvironment) || !Array.isArray(c.journeys) || !c.journeys.length ||
      new Set(c.journeys).size !== c.journeys.length || c.journeys.some(id => !productJourneys.some(j => j.id === id)) ||
      !object(c.baseline) || Object.keys(c.baseline).some(k => !["features", "connections"].includes(k)) || !object(c.baseline.features) || Object.entries(c.baseline.features).some(([k, v]) => !/^[a-z][a-zA-Z0-9_.-]{0,80}$/.test(k) || typeof v !== "boolean") ||
      !Array.isArray(c.baseline.connections) || c.baseline.connections.some(v => typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v)) ||
      !object(c.limits) || Object.keys(c.limits).some(k => !["durationMs", "modelBudgetCents", "maxRuns"].includes(k)) || !Number.isSafeInteger(c.limits.durationMs) || c.limits.durationMs < 1000 || c.limits.durationMs > 3_600_000 ||
      !Number.isSafeInteger(c.limits.modelBudgetCents) || c.limits.modelBudgetCents < 0 ||
      !Number.isSafeInteger(c.limits.maxRuns) || c.limits.maxRuns < 0) throw new Error("invalid_target_configuration");
  if (c.headed !== undefined && typeof c.headed !== "boolean") throw new Error("invalid_browser_mode");
  if (c.adapterModule !== undefined && (typeof c.adapterModule !== "string" || !c.adapterModule)) throw new Error("invalid_adapter_module");
  if (c.adapterConfig !== undefined && !object(c.adapterConfig)) throw new Error("invalid_adapter_configuration");
  if (c.modelProfileId !== undefined && !["runner-codex", "runner-codex-mini"].includes(c.modelProfileId)) throw new Error("unsupported_model_profile");
  if (c.mode === "new-cloud" && c.journeys[0] !== "cloud-onboarding") throw new Error("new_cloud_requires_onboarding_first");
  if (c.mode === "new-cloud" && c.baseline.connections.length) throw new Error("onboarding_requires_ui_connection_setup");
  if (c.mode !== "new-cloud" && c.journeys.includes("cloud-onboarding")) throw new Error("onboarding_requires_fresh_cloud_workspace");
  if (c.journeys.includes("cloud-onboarding") && (!c.limits.modelBudgetCents || !c.limits.maxRuns)) throw new Error("paid_journey_requires_limits");
  const requiredRuns = c.journeys.reduce((total, id) => total + (isAgentJourney(id) ? agentJourneyRuns[id] : 0), 0);
  if (requiredRuns && (!c.limits.modelBudgetCents || c.limits.maxRuns !== requiredRuns)) throw new Error(c.journeys.includes("ask-question") && requiredRuns === 1 ? "question_requires_one_bounded_run" : "agent_journeys_require_bounded_runs");
  if (c.mode !== "managed-self-hosted" && !c.adapterModule) throw new Error("cloud_target_requires_private_adapter");
  if (c.mode === "managed-self-hosted" && c.executionEnvironment !== "local") throw new Error("unsupported_self_hosted_environment");
  return { ...c, ...(c.journeys.includes("cloud-onboarding") ? { modelProfileId: c.modelProfileId ?? "runner-codex" as const } : {}), headed: c.headed ?? false, journeys: c.journeys as JourneyId[] };
}
