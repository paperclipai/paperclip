import { expect, it } from "vitest";
import { CHAT_OPENCODE_MODEL, reviewedChatProfile, reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { runnerMatrix, runnerProfiles } from "./catalog.js";
import { missingTeamAccountEnvironment } from "./chat-catalog-domains/external-team-configure.js";
const profile = { id: "runner-opencode", provider: "opencode", model: CHAT_OPENCODE_MODEL, adapterType: "paperclip_runner", credential: "OPENROUTER_API_KEY" };
it("pins the new controller identity and rejects model/provider/credential substitution", () => {
  expect(reviewedChatProfile(profile)).toBe(true);
  for (const patch of [{ id: "runner-unknown" }, { provider: "codex" }, { model: "openrouter/other/model" }, { credential: "CODEX_AUTH_JSON" }, { adapterType: "opencode_local" }])
    expect(reviewedChatProfile({ ...profile, ...patch })).toBe(false);
  expect(reviewedChatExecutionIds("secrets.vault-reference")).toEqual(["chat-features.runner-codex-subscription.local.secrets.vault-reference", "chat-features.runner-opencode.local.secrets.vault-reference"]);
});
it("changes the complete chat matrix without relabeling the existing global qualification model", () => {
  const cells = runnerMatrix.filter(cell => cell.suite.id === "chat-features" && cell.profile.id === "runner-opencode");
  expect(cells.length).toBe(244);
  expect(cells.every(cell => cell.profile.model === CHAT_OPENCODE_MODEL && reviewedChatProfile(cell.profile))).toBe(true);
  expect(runnerProfiles.find(row => row.id === "runner-opencode")!.model).not.toBe(CHAT_OPENCODE_MODEL);
  const cell = cells[0]!;
  const payload = cell.profile.buildAgent({ environmentId: "environment", environmentFixtureId: "local", workspacePath: "/owned", secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" } }, executionId: "owned" });
  expect(payload.adapterConfig).toMatchObject({ provider: "opencode", model: CHAT_OPENCODE_MODEL });
  expect(payload.adapterConfig).not.toHaveProperty("modelReasoningEffort");
  expect(payload.adapterConfig).not.toHaveProperty("codexPermissionMode");
});
it("withholds only the selected account from the missing OpenRouter member", () => {
  expect(missingTeamAccountEnvironment(false, "/owned/empty")).toEqual({ OPENROUTER_API_KEY: "" });
  expect(missingTeamAccountEnvironment(true, "/owned/empty")).toEqual({ CODEX_HOME: "/owned/empty", OPENAI_API_KEY: "", CODEX_API_KEY: "" });
});
