import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
    expect(transfer.credential).toEqual({ type: "auth-file", provider: "codex", content: JSON.stringify(auth) });
    const refreshed = { ...auth, tokens: { ...auth.tokens, refresh_token: "fixture-rotated" }, last_refresh: "2021-01-01T00:00:00Z" };
    await transfer.onCredentials!({ type: "auth-file", provider: "codex", content: JSON.stringify(refreshed) });
    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual(refreshed);
  });
  it("transfers a selected API key without requiring refresh authority", async () => {
    const directory = await home({ OPENAI_API_KEY: "fixture-key" });
    const transfer = await preparePluginRunnerCredentials({ provider: "codex", identity: "revision", accountIdentity: "account", home: directory, environment: {} });
    expect(transfer.needsWriteback).toBe(false);
    expect(transfer.credential).toEqual({ type: "auth-file", provider: "codex", content: JSON.stringify({ OPENAI_API_KEY: "fixture-key" }) });
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

describe("plugin Runner Google Antigravity credentials", () => {
  const signIn = (extra: Record<string, unknown> = {}) => JSON.stringify({
    client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
    refresh_token: "fixture-refresh", token_uri: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
    ...extra,
  });
  async function googleHome(contents: string) {
    const directory = await mkdtemp(join(tmpdir(), "plugin-runner-google-")); homes.push(directory);
    await mkdir(join(directory, "antigravity-acp"), { mode: 0o700 });
    await writeFile(join(directory, "antigravity-acp", "acp_token.json"), contents, { mode: 0o600 });
    return directory;
  }
  const blankManagedEnvironment = { GEMINI_API_KEY: "", GOOGLE_API_KEY: "", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "",
    GEMINI_HOME: "/controller/private/provider", HOME: "/controller/private", OTHER_SECRET: "fixture-unrelated" };
  it("transfers only the selected Gemini API key", async () => {
    const transfer = await preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", accountIdentity: "account",
      environment: { GEMINI_API_KEY: "fixture-gemini", GOOGLE_API_KEY: "fixture-google", GOOGLE_APPLICATION_CREDENTIALS: "/controller/private/adc.json",
        GOOGLE_GEMINI_BASE_URL: "https://router.example.test", GEMINI_HOME: "/controller/private/gemini", XAI_API_KEY: "fixture-xai",
        HOME: "/controller/private", OTHER_SECRET: "fixture-unrelated" } });
    expect(transfer).toEqual({ accountIdentity: "account", credential: { type: "provider-env", provider: "antigravity", environment: { GEMINI_API_KEY: "fixture-gemini" } } });
    expect(transfer.needsWriteback).toBeUndefined();
    expect(transfer.onCredentials).toBeUndefined();
  });
  it.each([
    ["the required scopes", signIn()],
    ["the optional project and OpenID scope", signIn({ project_id: "fixture-project",
      scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode", "openid"] })],
  ])("transfers the saved Google sign-in with %s exactly as the sanitizer outputs it", async (_name, saved) => {
    const directory = await googleHome(JSON.stringify({ ...JSON.parse(saved), access_token: "fixture-access", expiry: "2020-01-01T00:00:00Z", email: "alice@example.test" }));
    const transfer = await preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", accountIdentity: "account",
      home: directory, environment: blankManagedEnvironment });
    expect(transfer).toEqual({ accountIdentity: "account", needsWriteback: true,
      credential: { type: "provider-env", provider: "antigravity", environment: { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: saved } } });
    const delivered = transfer.credential!.type === "provider-env" ? transfer.credential!.environment.PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET : "";
    expect(delivered).not.toContain("fixture-access");
    expect(delivered).not.toContain("alice@example.test");
    expect(transfer.onCredentials).toBeUndefined();
  });
  it("prefers a selected Gemini API key over a managed home", async () => {
    const directory = await googleHome(signIn());
    const transfer = await preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", home: directory,
      environment: { ...blankManagedEnvironment, GEMINI_API_KEY: "fixture-gemini" } });
    expect(transfer.credential).toEqual({ type: "provider-env", provider: "antigravity", environment: { GEMINI_API_KEY: "fixture-gemini" } });
    expect(transfer.needsWriteback).toBeUndefined();
  });
  it.each([
    ["a sign-in supplied through the environment", { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "{\"refresh_token\":\"fixture-refresh\"}" }, "selected credential unavailable"],
    ["a sign-in beside a Gemini API key", { GEMINI_API_KEY: "fixture-gemini", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "{\"refresh_token\":\"fixture-refresh\"}" }, "selected credential unavailable"],
    ["no key and no saved sign-in", {}, "Gemini API key or a saved Google sign-in"],
    ["a blank key and no saved sign-in", { GEMINI_API_KEY: "   " }, "Gemini API key or a saved Google sign-in"],
    ["only a Google API key", { GOOGLE_API_KEY: "fixture-google" }, "Gemini API key or a saved Google sign-in"],
  ] as const)("refuses %s", async (_name, environment, message) => {
    const result = preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", environment });
    await expect(result).rejects.toThrow(message);
    await result.catch((error: Error) => expect(error.message).not.toContain("fixture"));
  });
  it.each([
    ["a missing token file", null],
    ["a token for another OAuth client", JSON.stringify({ ...JSON.parse(signIn()), client_id: "fixture-other-client" })],
    ["a token without the required scopes", JSON.stringify({ ...JSON.parse(signIn()), scopes: [] })],
    ["unreadable JSON", "{fixture-refresh"],
  ])("refuses %s in plain words without echoing it", async (_name, contents) => {
    const directory = contents === null ? await mkdtemp(join(tmpdir(), "plugin-runner-google-")) : await googleHome(contents);
    if (contents === null) homes.push(directory);
    const result = preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", home: directory, environment: blankManagedEnvironment });
    await expect(result).rejects.toThrow("The selected Google Antigravity account is unavailable. Reconnect the Google account, then retry.");
    await result.catch((error: Error) => expect(error.message).not.toContain("fixture"));
  });
  it("fails closed for an invalid Gemini API key without echoing it", async () => {
    const result = preparePluginRunnerCredentials({ provider: "antigravity", identity: "revision", environment: { GEMINI_API_KEY: "fixture\0gemini" } });
    await expect(result).rejects.toThrow("Plugin Runner selected credential unavailable");
    await result.catch((error: Error) => expect(error.message).not.toContain("fixture"));
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
  it("sends a Grok subscription as its saved sign-in file and requires the managed writeback", async () => {
    const grokAuth = { "https://auth.x.ai::00000000-0000-4000-8000-000000000000": { key: "fixture-key", refresh_token: "fixture-refresh" } };
    const directory = await home(grokAuth);
    const transfer = await preparePluginRunnerCredentials({ provider: "grok", identity: "revision", accountIdentity: "account",
      home: directory, environment: blanks });
    expect(transfer).toEqual({ accountIdentity: "account", needsWriteback: true,
      credential: { type: "auth-file", provider: "grok", content: JSON.stringify(grokAuth) } });
  });
  it("refuses a Grok subscription without a usable sign-in file", async () => {
    await expect(preparePluginRunnerCredentials({ provider: "grok", identity: "revision", environment: blanks }))
      .rejects.toThrow("credential home unavailable");
    const directory = await home({ "https://auth.x.ai::00000000-0000-4000-8000-000000000000": { key: "fixture-key" } });
    await expect(preparePluginRunnerCredentials({ provider: "grok", identity: "revision", home: directory, environment: blanks }))
      .rejects.toThrow("credential invalid");
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
