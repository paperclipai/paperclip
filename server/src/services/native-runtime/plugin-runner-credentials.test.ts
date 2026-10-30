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
    await expect(preparePluginRunnerCredentials({ provider: "opencode", identity: "revision", environment: {} })).rejects.toThrow("credential provider");
  });
});

it("transfers only broker authority even when the provider owns its AI account", async () => {
  const result = await preparePluginRunnerCredentials({provider:"codex",home:"/must/not/read",environment:{
    PAPERCLIP_GITHUB_BROKER_URL:"https://core.example.test",PAPERCLIP_GITHUB_BROKER_TOKEN:"runtime-capability",
    GH_TOKEN:"ambient-secret",PAPERCLIP_API_KEY:"unrelated-key",HOME:"/controller/private"}});
  expect(result).toEqual({githubBroker:{url:"https://core.example.test",token:"runtime-capability"}});
});
