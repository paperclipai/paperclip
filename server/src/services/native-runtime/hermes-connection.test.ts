import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput, isNativeAcpxPermissionModePinned } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { projectHermesConnection, restoreHermesCredential } from "./hermes-connection.js";
import type { AiConnectionMetadata } from "@paperclipai/shared";
describe("Hermes Connections projection", () => {
  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", "anthropic"], ["openai", "OPENAI_API_KEY", "openai"],
    ["openrouter", "OPENROUTER_API_KEY", "openrouter"], ["xai", "XAI_API_KEY", "xai"], ["google", "GEMINI_API_KEY", "gemini"],
  ] as const)("uses the selected %s credential and exact model", (provider, key, native) => {
    const projected = projectHermesConnection({ provider, method: "api_key" }, "provider/exact-model", "fixture-secret");
    expect(projected.env).toEqual({ [key]: "fixture-secret" });
    expect(projected.config).toEqual({ model: { provider: native, default: "provider/exact-model" } });
    expect(JSON.stringify(projected.config)).not.toContain("fixture-secret");
  });
  it("projects a Claude subscription without reading another harness home", () => {
    expect(projectHermesConnection({ provider: "anthropic", method: "subscription" }, "claude-model", "fixture-oauth").env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" });
  });
  it("preserves OpenAI account metadata on refresh and rejects account changes", () => {
    const original = JSON.stringify({ tokens: { access_token: "old", refresh_token: "old-refresh", account_id: "account" }, unrelated: "keep" });
    const projected = projectHermesConnection({ provider: "openai", method: "subscription" }, "model", original);
    expect(restoreHermesCredential("openai", original, JSON.stringify(projected.auth))).toBe(original);
    const native = { version: 1, providers: { "openai-codex": { tokens: { access_token: "new", refresh_token: "new-refresh", account_id: "account" }, last_refresh: "2026-10-07T00:00:00Z" } } };
    expect(JSON.parse(restoreHermesCredential("openai", original, JSON.stringify(native)))).toMatchObject({ unrelated: "keep", tokens: { account_id: "account", access_token: "new" } });
    native.providers["openai-codex"].tokens.account_id = "other";
    expect(() => restoreHermesCredential("openai", original, JSON.stringify(native))).toThrow("changed accounts");
  });
  it("does not forward an API key for an unauthenticated custom endpoint", () => {
    const connection = { provider: "openai", method: "api_key", routing: { kind: "local", protocol: "chat", baseUrl: "http://localhost:11434/v1", auth: "none", models: [] } } satisfies AiConnectionMetadata;
    const projected = projectHermesConnection(connection, "local-model", "");
    expect(projected.env).toEqual({});
    expect(projected.config).toMatchObject({ paperclip_auth: { protocol: "chat", style: "none" }, providers: { paperclip: { transport: "chat_completions" } } });
  });
  it.each([
    ["chat", "bearer", "chat_completions", "OPENAI_API_KEY"],
    ["responses", "bearer", "codex_responses", "OPENAI_API_KEY"],
    ["messages", "api_key", "anthropic_messages", "ANTHROPIC_API_KEY"],
    ["messages", "bearer", "anthropic_messages", "ANTHROPIC_AUTH_TOKEN"],
  ] as const)("preserves %s with %s authentication on a custom route", (protocol, auth, transport, key) => {
    const connection = { provider: "openai", method: "api_key", routing: {
      kind: "gateway", protocol, auth, baseUrl: "https://models.example.test/v1", models: [],
    } } satisfies AiConnectionMetadata;
    const result = projectHermesConnection(connection, "tenant/exact-model", "fixture-secret");
    expect(result.env).toEqual({ [key]: "fixture-secret" });
    expect(result.config).toMatchObject({ paperclip_auth: { protocol, style: auth }, providers: {
      paperclip: { transport, key_env: key, default_model: "tenant/exact-model" },
    } });
    expect(JSON.stringify(result.config)).not.toContain("fixture-secret");
  });
  it("pins the managed Bedrock region without falling back to instance credentials", () => {
    const result = projectHermesConnection({ provider: "anthropic", method: "api_key", routing: {
      kind: "bedrock", protocol: "bedrock", auth: "bearer", region: "us-west-2", models: [],
    } }, "us.anthropic.exact-model", "fixture-bedrock-key");
    expect(result.env).toEqual({ AWS_BEARER_TOKEN_BEDROCK: "fixture-bedrock-key", AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-west-2", AWS_EC2_METADATA_DISABLED: "true" });
    expect(result.config).toEqual({ model: { provider: "bedrock", default: "us.anthropic.exact-model" }, bedrock: { region: "us-west-2" } });
  });
  it("roundtrips Grok refreshes while binding the original JWT issuer and subject", () => {
    const jwt = (sub: string, exp: number) => `header.${Buffer.from(JSON.stringify({ iss: "https://auth.example.test", sub, exp })).toString("base64url")}.signature`;
    const original = JSON.stringify({ account: { key: jwt("same", 100), refresh_token: "refresh-old", expires_at: 100, metadata: "keep" } });
    const result = projectHermesConnection({ provider: "xai", method: "subscription" }, "grok-model", original);
    expect(restoreHermesCredential("xai", original, JSON.stringify(result.auth))).toBe(original);
    const refreshed = { version: 1, providers: { "xai-oauth": { tokens: { access_token: jwt("same", 200), refresh_token: "refresh-new" } } } };
    expect(JSON.parse(restoreHermesCredential("xai", original, JSON.stringify(refreshed)))).toMatchObject({ account: { refresh_token: "refresh-new", expires_at: 200, metadata: "keep" } });
    refreshed.providers["xai-oauth"].tokens.access_token = jwt("other", 300);
    expect(() => restoreHermesCredential("xai", original, JSON.stringify(refreshed))).toThrow("account identity");
  });
});

// Use the server constructor and the same policy projection as its transport factory.
describe("server-launched Hermes permission policy", () => {
  it.each(["approve-all", "approve-reads"] as const)("pins v7 %s policy before native transport admission", permissionMode => {
    const input = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent",
      issue: { id: "issue", identifier: "HERMES-1", title: "Server launch", description: null, workMode: "standard" },
      taskPrompt: "Run the task.", workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "acpx", acpxAgent: "hermes", model: "hermes-fixture",
      hermesConnectionFingerprint: "1".repeat(64), acpxPermissionMode: permissionMode,
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Run the task.", criteria: [{ id: "output", requirement: "Run the task." }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(input.schema).toBe("paperclip.native-execution-input.v7");
    expect(input.provider).toMatchObject({ kind: "acpx", agent: "hermes", permissionMode });
    expect(isNativeAcpxPermissionModePinned(input)).toBe(true);
    expect(isNativeAcpxPermissionModePinned(parseNativeExecutionInput({ ...input, schema: "paperclip.native-execution-input.v6" }))).toBe(true);
    expect(isNativeAcpxPermissionModePinned({ ...input, schema: "paperclip.native-execution-input.v3" })).toBe(false);
    expect(isNativeAcpxPermissionModePinned({ ...input, provider: { kind: "codex", model: null, approvalPolicy: "never" } })).toBe(false);
  });
});
