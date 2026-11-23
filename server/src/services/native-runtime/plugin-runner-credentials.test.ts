import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePluginRunnerCredentials } from "./plugin-runner-credentials.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function home(auth: object) {
  const directory = await mkdtemp(join(tmpdir(), "plugin-runner-account-")); homes.push(directory);
  await writeFile(join(directory, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return directory;
}
const auth = { tokens: { account_id: "fixture-account", access_token: "fixture-access", refresh_token: "fixture-refresh" }, last_refresh: "2020-01-01T00:00:00Z" };
describe("plugin Runner selected credentials", () => {
  it("sends the selected Codex account and preserves a newer refresh for normal secret writeback", async () => {
    const directory = await home(auth);
    const transfer = await preparePluginRunnerCredentials({ provider: "codex", identity: "revision", accountIdentity: "account", home: directory, environment: {} });
    expect(transfer.accountIdentity).toBe("account");
    expect(transfer.needsWriteback).toBe(true);
    expect(transfer.credential).toEqual({ type: "codex-auth-json", authJson: JSON.stringify(auth) });
    const refreshed = { ...auth, tokens: { ...auth.tokens, refresh_token: "fixture-rotated" }, last_refresh: "2021-01-01T00:00:00Z" };
    await transfer.onCredentials!({ type: "codex-auth-json", authJson: JSON.stringify(refreshed) });
    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual(refreshed);
  });
  it("transfers a selected API key without requiring refresh authority", async () => {
    const directory = await home({ OPENAI_API_KEY: "fixture-key" });
    const transfer = await preparePluginRunnerCredentials({ provider: "codex", identity: "revision", accountIdentity: "account", home: directory, environment: {} });
    expect(transfer.needsWriteback).toBe(false);
    expect(transfer.credential).toEqual({ type: "codex-auth-json", authJson: JSON.stringify({ OPENAI_API_KEY: "fixture-key" }) });
  });
  it("transfers only the selected Claude authentication variable", async () => {
    const transfer = await preparePluginRunnerCredentials({ provider: "claude", identity: "revision", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth", HOME: "/controller/private", OTHER_SECRET: "fixture-unrelated" } });
    expect(transfer.credential).toEqual({ type: "claude-env", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" } });
    await expect(preparePluginRunnerCredentials({ provider: "claude", identity: "revision", environment: { ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://router.example.test" } })).rejects.toThrow("routing");
  });
  it("does not read a controller credential when the provider owns the account", async () => {
    expect(await preparePluginRunnerCredentials({ provider: "codex", home: "/must/not/read", environment: {} })).toEqual({});
    await expect(preparePluginRunnerCredentials({ provider: "cursor", identity: "revision", environment: { CURSOR_API_KEY: "fixture-key" } })).rejects.toThrow("credential provider");
  });
});

describe("plugin Runner provider environment credentials", () => {
  const blanks = { XAI_API_KEY: "", COPILOT_GITHUB_TOKEN: "", OPENROUTER_API_KEY: "", PAPERCLIP_AI_PROVIDER_URL: "", PAPERCLIP_AI_PROVIDER_KEY: "",
    ANTHROPIC_API_KEY: "", HOME: "/controller/private", GROK_HOME: "/controller/private/provider", OTHER_SECRET: "fixture-unrelated" };
  it.each([
    ["grok", { XAI_API_KEY: "fixture-xai" }],
    ["copilot", { COPILOT_GITHUB_TOKEN: "fixture-copilot" }],
    ["opencode", { OPENROUTER_API_KEY: "fixture-openrouter" }],
    ["opencode", { PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example.test/v1", PAPERCLIP_AI_PROVIDER_KEY: "fixture-gateway" }],
  ] as const)("transfers only the selected %s variables", async (provider, environment) => {
    const transfer = await preparePluginRunnerCredentials({ provider, identity: "revision", accountIdentity: "account",
      environment: { ...blanks, ...environment, OPENCODE_CONFIG_CONTENT: "{\"provider\":{}}" } });
    expect(transfer).toEqual({ accountIdentity: "account", credential: { type: "provider-env", provider, environment } });
    expect(transfer.needsWriteback).toBeUndefined();
  });
  it("uses the credential revision as the account when no account identity is supplied", async () => {
    const transfer = await preparePluginRunnerCredentials({ provider: "copilot", identity: "revision", environment: { COPILOT_GITHUB_TOKEN: "fixture-copilot" } });
    expect(transfer.accountIdentity).toBe("revision");
  });
  it("keeps the GitHub broker authority beside the provider credential", async () => {
    const transfer = await preparePluginRunnerCredentials({ provider: "grok", identity: "revision", environment: {
      XAI_API_KEY: "fixture-xai", PAPERCLIP_GITHUB_BROKER_URL: "https://core.example.test", PAPERCLIP_GITHUB_BROKER_TOKEN: "runtime-capability" } });
    expect(transfer.githubBroker).toEqual({ url: "https://core.example.test", token: "runtime-capability" });
    expect(transfer.credential).toEqual({ type: "provider-env", provider: "grok", environment: { XAI_API_KEY: "fixture-xai" } });
  });
  it("refuses a Grok subscription, which needs an auth file with refresh and writeback", async () => {
    await expect(preparePluginRunnerCredentials({ provider: "grok", identity: "revision", home: "/controller/private/provider",
      environment: blanks })).rejects.toThrow("Grok subscription login is not supported");
  });
  it("refuses Grok provider routing that would redirect the key", async () => {
    await expect(preparePluginRunnerCredentials({ provider: "grok", identity: "revision",
      environment: { XAI_API_KEY: "fixture-xai", XAI_BASE_URL: "https://router.example.test" } })).rejects.toThrow("routing");
  });
  it.each([
    ["copilot", {}],
    ["opencode", {}],
    ["opencode", { PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example.test/v1" }],
    ["opencode", { PAPERCLIP_AI_PROVIDER_KEY: "fixture-gateway" }],
    ["opencode", { OPENROUTER_API_KEY: "fixture-openrouter", PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example.test/v1", PAPERCLIP_AI_PROVIDER_KEY: "fixture-gateway" }],
    ["opencode", { OPENROUTER_API_KEY: "fixture\0value" }],
  ] as const)("fails closed for an incomplete or ambiguous %s credential", async (provider, environment) => {
    const result = preparePluginRunnerCredentials({ provider, identity: "revision", environment: { ...blanks, ...environment } });
    await expect(result).rejects.toThrow("Plugin Runner selected credential unavailable");
    await result.catch((error: Error) => expect(error.message).not.toContain("fixture"));
  });
});

it("transfers only broker authority even when the provider owns its AI account", async () => {
  const result = await preparePluginRunnerCredentials({provider:"codex",home:"/must/not/read",environment:{
    PAPERCLIP_GITHUB_BROKER_URL:"https://core.example.test",PAPERCLIP_GITHUB_BROKER_TOKEN:"runtime-capability",
    GH_TOKEN:"ambient-secret",PAPERCLIP_API_KEY:"unrelated-key",HOME:"/controller/private"}});
  expect(result).toEqual({githubBroker:{url:"https://core.example.test",token:"runtime-capability"}});
});
