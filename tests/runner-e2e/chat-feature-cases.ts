import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export const CHAT_FEATURE_SUITE = "chat-features";
export const CHAT_FEATURE_BUDGET_CENTS = 500;
export const CHAT_FEATURE_GRADER = "paperclip.chat-features.v1";
export const CHAT_FEATURE_CASES = ["create-backlog", "delegate-announcement"] as const;
export type ChatFeatureCase = typeof CHAT_FEATURE_CASES[number];
export interface ChatScenario {
  id: string; capabilities: string[]; context: string; query: string; expected_outcome: string;
}

export function readChatFeatureScenarios(text = readFileSync(new URL("./chat-scenarios/tasks.yaml", import.meta.url), "utf8")): ChatScenario[] {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid chat scenario YAML: ${document.errors[0]!.message}`);
  const value = document.toJS();
  if (value?.schema_version !== 1 || value.feature !== "tasks" || value.status !== "planned" || !Array.isArray(value.scenarios)) {
    throw new Error("Unsupported chat scenario catalog");
  }
  const ids = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!scenario || ["id", "context", "query", "expected_outcome"].some(key => typeof scenario[key] !== "string" || !scenario[key].trim())
      || !Array.isArray(scenario.capabilities) || !scenario.capabilities.length
      || scenario.capabilities.some((id: unknown) => typeof id !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id))
      || ids.has(scenario.id)) throw new Error("Invalid or duplicate chat scenario");
    ids.add(scenario.id);
  }
  return CHAT_FEATURE_CASES.map(caseId => {
    const scenario = value.scenarios.find((candidate: ChatScenario) => candidate.id === `tasks.${caseId}`);
    if (!scenario) throw new Error(`Missing chat scenario: tasks.${caseId}`);
    return scenario;
  });
}
export const chatFeatureScenarios = readChatFeatureScenarios();
export const chatFeatureDefinitionDigest = createHash("sha256").update([
  "chat-feature-cases.ts", "chat-feature-flow.ts", "chat-feature-scoring.ts", "chat-flow.ts",
  "completion-updates.ts", "redaction.ts", "launch.ts", "chat-scenarios/tasks.yaml", "chat-scenarios/defaults.yaml",
  "../../server/src/services/agent-conversations.ts",
].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n")).digest("hex");

export function chatFeatureProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return { ...profile, buildAgent(input) {
    const { instructionsBundle: _manual, ...payload } = profile.buildAgent(input);
    const config = payload.adapterConfig as Record<string, unknown>;
    const { codexPermissionMode: _permission, ...adapterConfig } = config;
    return { ...payload, name: "CEO", title: "CEO", role: "ceo",
      capabilities: "Coordinates company work and delegates tasks to the team.",
      budgetMonthlyCents: CHAT_FEATURE_BUDGET_CENTS,
      adapterConfig: { ...adapterConfig, timeoutSec: 120, modelReasoningEffort: "low" },
      runtimeConfig: { ...(payload.runtimeConfig as Record<string, unknown>),
        heartbeat: { enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 3, maxDailyCostCents: CHAT_FEATURE_BUDGET_CENTS } },
    };
  } };
}
export const chatFeatureTasks: readonly RunnerTaskFixture[] = CHAT_FEATURE_CASES.map((id, index) => ({
  id, label: id === "create-backlog" ? "Save a task for Morgan without starting it" : "Delegate an announcement and return its saved result",
  groups: ["chat"], flow: "agent_chat", workMode: "standard",
  expectedRunCount: id === "create-backlog" ? 1 : 3,
  automaticRetryPolicy: "single_attempt", turnTimeoutMs: 120_000,
  attemptTimeoutMs: { local: 420_000, daytona: 420_000 },
  expectedTerminalState: { issue: "in_review", run: "succeeded" },
  buildTitle: nonce => `Chat feature ${id} ${nonce}`,
  buildPrompt: () => chatFeatureScenarios[index]!.query,
  buildVisibleMarker: nonce => `ACORN${nonce.replace(/[^a-zA-Z0-9]/g, "")}`,
  buildMatchers: () => [{ kind: "issue_status", expected: "in_review" }],
}));
