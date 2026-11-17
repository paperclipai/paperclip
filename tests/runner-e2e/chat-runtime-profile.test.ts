import { expect, it } from "vitest";
import { CHAT_OPENCODE_MODEL, reviewedChatProfile, reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { runnerMatrix, runnerProfiles } from "./catalog.js";
import { CHAT_NATIVE_TIMEOUT_POLICY } from "./chat-native-timeout-policy.js";
import { chatFeatureProfile } from "./chat-feature-cases.js";
import type { RunnerProfileFixture } from "./types.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import type { RunnerApi } from "./api.js";
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
  expect(payload.adapterConfig).toMatchObject({ opencodePermissionMode: "allow", env: {
    OPENROUTER_API_KEY: { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" },
  } });
  const env = (payload.adapterConfig as { env: Record<string, string> }).env;
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ provider: { openrouter: { models: {
    "deepseek/deepseek-v4.1-flash-1017": { options: { provider: { sort: "throughput" } } },
  } } } });
  expect(Object.keys(env).sort()).toEqual(["OPENCODE_CONFIG_CONTENT", "OPENROUTER_API_KEY"]);
});
it("withholds only the selected account from the missing OpenRouter member", () => {
  expect(missingTeamAccountEnvironment(false, "/owned/empty")).toEqual({ OPENROUTER_API_KEY: "" });
  expect(missingTeamAccountEnvironment(true, "/owned/empty")).toEqual({ CODEX_HOME: "/owned/empty", OPENAI_API_KEY: "", CODEX_API_KEY: "" });
});

it("scopes routing preference to the reviewed chat profile while preserving its configured environment", () => {
  const input = { environmentId: "environment", environmentFixtureId: "local" as const, workspacePath: "/owned", secretRefs: {}, executionId: "owned" };
  const config = { provider: "opencode", model: CHAT_OPENCODE_MODEL, opencodePermissionMode: "ask", env: { CUSTOM_SETTING: "kept" } };
  const base = { ...runnerProfiles.find(row => row.id === "runner-opencode")!, ...profile,
    buildAgent: () => ({ adapterConfig: structuredClone(config), runtimeConfig: {} }) } as RunnerProfileFixture;
  const selected = chatFeatureProfile(base).buildAgent(input);
  expect(selected.adapterConfig).toMatchObject(config);
  expect((selected.adapterConfig as {env: Record<string,string>}).env.OPENCODE_CONFIG_CONTENT).toBeDefined();
  for (const patch of [{id:"runner-opencode-deepseek-1017"},{provider:"codex"},{model:"openrouter/other/model"},{adapterType:"opencode_local"},{credential:"OPENAI_API_KEY"}]) {
    const excluded = chatFeatureProfile({...base,...patch} as RunnerProfileFixture).buildAgent(input);
    expect(excluded.adapterConfig).toEqual({...config,timeoutSec:patch.id ? 120 : CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec,...(patch.provider === "codex" ? {modelReasoningEffort:"low"} : {})});
  }
  const global = runnerProfiles.find(row => row.id === "runner-opencode")!;
  const payload = global.buildAgent({...input,secretRefs:{OPENROUTER_API_KEY:{type:"secret_ref",secretId:"22222222-2222-4222-8222-222222222222",version:"latest"}}});
  expect(payload.adapterConfig).not.toHaveProperty("env.OPENCODE_CONFIG_CONTENT");
});

it("posts the reviewed routing configuration through the ordinary agent fixture boundary", async () => {
  const execution = runnerMatrix.find(cell => cell.suite.id === "chat-features" && cell.profile.id === "runner-opencode")!;
  let saved: Record<string, unknown> | undefined;
  const api = {
    async get() { return [{id:"local",driver:"local"}]; },
    async postSensitive() { return {id:"encrypted-account"}; },
    async post(url: string, body: Record<string, unknown>) {
      if (url === "/api/companies") return {id:"company",name:"Fixture"};
      if (url === "/api/companies/company/agents") { saved=body; return {id:"ceo",...body}; }
      throw new Error("Unexpected fixture route");
    },
  } as unknown as RunnerApi;
  const fixtures = await setupLiveFixtures({api,execution,executionNonce:"routing",workspacePath:"/owned",credentials:{OPENROUTER_API_KEY:"synthetic-account-input"}});
  try {
    const config=saved!.adapterConfig as {provider:string;model:string;env:Record<string,unknown>};
    expect(config).toMatchObject({provider:"opencode",model:CHAT_OPENCODE_MODEL});
    expect(config.env.OPENROUTER_API_KEY).toEqual({type:"secret_ref",secretId:"encrypted-account",version:"latest"});
    expect(JSON.parse(config.env.OPENCODE_CONFIG_CONTENT as string)).toEqual({provider:{openrouter:{models:{"deepseek/deepseek-v4.1-flash-1017":{options:{provider:{sort:"throughput"}}}}}}});
  } finally { await fixtures.teardown(); }
});
