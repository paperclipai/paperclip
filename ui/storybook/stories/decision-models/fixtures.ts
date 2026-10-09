import type { DecisionConnectionChoice, DecisionHistoryEntry, DecisionModelSettings, DecisionResult } from "@paperclipai/shared";

export const companyId = "company-storybook";
export const choices: DecisionConnectionChoice[] = ["openai", "openrouter"].map((provider, i) => ({
  id: `10000000-0000-4000-8000-00000000000${i + 1}`,
  grantId: `20000000-0000-4000-8000-00000000000${i + 1}`,
  companyId, provider: provider as "openai" | "openrouter", method: "api_key", ownership: "shared",
  name: i === 0 ? "Company OpenAI" : "Company OpenRouter", isDefault: false, status: "connected",
  decisionModel: i === 0 ? "gpt-6-luna" : "typesafe/jev-1.13",
}));
export const unconfigured: DecisionModelSettings = { companyId, enabled: false, allowBackground: true, connectionId: null, grantId: null, provider: null, model: null };
export const configured: DecisionModelSettings = { ...unconfigured, enabled: true, connectionId: choices[0]!.id, grantId: choices[0]!.grantId, provider: "openai", model: "gpt-6-luna" };
export const result: DecisionResult = { status: "succeeded", invocationId: "decision-fixture", answers: {
  billing: { type: "boolean", probability: 0.99 }, team: { type: "choice", choice: "billing", probabilities: { billing: 0.98, technical: 0.02 } }, severity: { type: "score", score: 0.08 },
}, usage: { inputTokens: 140, outputTokens: 0, costCents: "0.0014000", costStatus: "estimated" } };
export const entry: DecisionHistoryEntry = {
  id: "decision-fixture", feature: "settings.test", actorType: "user", responsibleUserId: "user-board", userName: "Board Operator",
  issueId: null, issueIdentifier: null, agentId: null, runId: null, connectionId: choices[0]!.id, provider: "openai", model: "gpt-6-luna",
  status: "succeeded", errorCode: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 423,
  inputTokens: 140, outputTokens: 0, costCents: "0.0014000", costStatus: "estimated",
};
