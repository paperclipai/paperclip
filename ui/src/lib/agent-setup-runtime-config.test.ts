import { describe, expect, it } from "vitest";
import { preserveLocalSetupRuntimeConfig } from "./agent-setup-runtime-config";

const saved = {
  adapterType: "codex_local" as const, defaultEnvironmentId: "local",
  adapterConfig: {
    command: "C:\\Tools with spaces\\codex.exe", engine: "cli", timeoutSec: 120,
    dangerouslyBypassApprovalsAndSandbox: false, model: "old-model", modelReasoningEffort: "high",
    apiKey: "old-inline-key", cwd: "C:\\project", extraArgs: ["--verbose"],
    env: { SystemRoot: "C:\\Windows", OLD_PROVIDER_TOKEN: "old-account" },
  },
  runtimeConfig: { aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" } as const },
};
const input = { adapterType: "codex_local", runner: "legacy" as const, environmentId: "local", savedEnvironmentId: "local",
  aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" } as const, saved };

describe("local setup runtime preservation", () => {
  it.each([
    ["codex_local", { OPENAI_API_KEY: "old-key" }, { CODEX_HOME: { type: "secret_ref", secretId: "new-home", version: "latest" } }],
    ["codex_local", { CODEX_API_KEY: "old-key" }, { CODEX_HOME: { type: "secret_ref", secretId: "new-home", version: "latest" } }],
    ["codex_local", { CODEX_HOME: "old-home" }, { OPENAI_API_KEY: { type: "secret_ref", secretId: "new-key", version: "latest" } }],
    ["codex_local", { CODEX_HOME: "old-home" }, { CODEX_HOME: "new-home" }],
    ["codex_local", { OPENAI_API_KEY: "old-key" }, { OPENAI_API_KEY: "new-key" }],
    ["claude_local", { ANTHROPIC_API_KEY: "old-key" }, { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "new-oauth", version: "latest" } }],
    ["claude_local", { ANTHROPIC_AUTH_TOKEN: "old-token" }, { ANTHROPIC_API_KEY: "new-key" }],
    ["claude_local", { CLAUDE_CONFIG_DIR: "old-home" }, { CLAUDE_CODE_OAUTH_TOKEN: "new-oauth" }],
    ["claude_local", { CLAUDE_CODE_OAUTH_TOKEN: "old-oauth" }, { ANTHROPIC_API_KEY: "new-key" }],
    ["claude_local", { CLAUDE_CODE_OAUTH_TOKEN: "old-oauth" }, { CLAUDE_CODE_OAUTH_TOKEN: "new-oauth" }],
  ] as const)("isolates legacy credential choices for %s", (adapterType, previous, selected) => {
    const env = { ...previous, OLD_ACCOUNT_TOKEN: "old-account", OPENAI_BASE_URL: "https://old-account.invalid" };
    const result = preserveLocalSetupRuntimeConfig({ env: selected }, { ...input, adapterType, aiConnection: undefined,
      saved: { ...saved, adapterType, adapterConfig: { ...saved.adapterConfig, env }, runtimeConfig: {} } });
    expect(result.env).toMatchObject(selected);
    expect(result.env).not.toHaveProperty("OLD_ACCOUNT_TOKEN");
    expect(result.env).not.toHaveProperty("OPENAI_BASE_URL");
    for (const key of Object.keys(previous)) {
      if (!(key in selected)) expect((result.env as Record<string, unknown>)[key] ?? "").toBe("");
    }
    expect(result).toMatchObject({ command: saved.adapterConfig.command, engine: "cli", dangerouslyBypassApprovalsAndSandbox: false });
    expect(env.OLD_ACCOUNT_TOKEN).toBe("old-account");
  });

  it.each([
    ["codex_local", "OPENAI_API_KEY", { type: "secret_ref", secretId: "same" }, { secretId: "same", version: "latest", type: "secret_ref" }],
    ["codex_local", "CODEX_HOME", { type: "secret_ref", secretId: "same", version: "latest" }, { version: "latest", secretId: "same", type: "secret_ref" }],
    ["claude_local", "ANTHROPIC_API_KEY", "same", { type: "plain", value: "same" }],
    ["claude_local", "CLAUDE_CODE_OAUTH_TOKEN", { type: "user_secret_ref", key: "same", required: true }, { type: "user_secret_ref", key: "same", version: "latest" }],
  ] as const)("keeps host settings for the same legacy credential %s/%s", (adapterType, key, previous, selected) => {
    const result = preserveLocalSetupRuntimeConfig({ env: { [key]: selected } }, { ...input, adapterType, aiConnection: undefined,
      saved: { ...saved, adapterType, adapterConfig: { ...saved.adapterConfig, env: { [key]: previous, SystemRoot: "C:\\Windows", HTTPS_PROXY: "https://same-host.invalid" } }, runtimeConfig: {} } });
    expect(result.env).toMatchObject({ [key]: selected, SystemRoot: "C:\\Windows", HTTPS_PROXY: "https://same-host.invalid" });
  });

  it("keeps explicit host-auth clearing when reusing a legacy subscription", () => {
    const result = preserveLocalSetupRuntimeConfig({ env: { CODEX_HOME: "same-home" } }, { ...input, aiConnection: undefined,
      saved: { ...saved, adapterConfig: { env: { CODEX_HOME: "same-home", OPENAI_API_KEY: "", SystemRoot: "C:\\Windows" } }, runtimeConfig: {} } });
    expect(result.env).toMatchObject({ CODEX_HOME: "same-home", OPENAI_API_KEY: "", SystemRoot: "C:\\Windows" });
  });

  it("drops host settings when the old environment cannot be resolved, retaining ACP restrictions", () => {
    const result = preserveLocalSetupRuntimeConfig({}, { ...input, environmentId: "remote", savedEnvironmentId: undefined,
      saved: { ...saved, adapterConfig: { ...saved.adapterConfig, engine: "acp", permissionMode: "deny-all" } } });
    expect(result).toMatchObject({ engine: "acp", permissionMode: "deny-all" });
    for (const key of ["command", "cwd", "extraArgs", "env"]) expect(result).not.toHaveProperty(key);
  });

  it.each(["permissionMode", "acpPermissionMode"].flatMap(key =>
    ["deny-all", "approve-reads"].map(mode => ({ key, mode })),
  ))("preserves restrictive ACP $key=$mode across execution environments", ({ key, mode }) => {
    const result = preserveLocalSetupRuntimeConfig({}, { ...input, environmentId: "remote",
      saved: { ...saved, adapterConfig: { ...saved.adapterConfig, engine: "acp", [key]: mode } } });
    expect(result).toMatchObject({ engine: "acp", [key]: mode });
    for (const field of ["command", "cwd", "extraArgs", "env"]) expect(result).not.toHaveProperty(field);
  });

  it("preserves runtime restrictions while applying the new model and clearing automatic effort", () => {
    const before = structuredClone(saved);
    const result = preserveLocalSetupRuntimeConfig({ model: "new-model", timeoutSec: 0, dangerouslyBypassApprovalsAndSandbox: true }, input);
    expect(result).toMatchObject({ command: saved.adapterConfig.command, engine: "cli", model: "new-model", timeoutSec: 120, dangerouslyBypassApprovalsAndSandbox: false });
    expect(result).not.toHaveProperty("modelReasoningEffort");
    expect(result).not.toHaveProperty("apiKey");
    expect(saved).toEqual(before);
  });

  it("does not carry local commands or credentials into a native runner", () => {
    const config = { provider: "codex", model: "new-model" };
    expect(preserveLocalSetupRuntimeConfig(config, { ...input, runner: "paperclip" })).toEqual(config);
  });

  it("does not carry configuration across adapter changes", () => {
    const config = { model: "claude-model" };
    expect(preserveLocalSetupRuntimeConfig(config, { ...input, adapterType: "claude_local" })).toEqual(config);
  });

  it("drops host paths and old environment bindings on an environment change, retaining restrictive policy", () => {
    const result = preserveLocalSetupRuntimeConfig({ model: "remote-model" }, { ...input, environmentId: "remote",
      saved: { ...saved, adapterConfig: { ...saved.adapterConfig, futureHostSetting: "host-only" } } });
    for (const key of ["command", "cwd", "extraArgs", "env", "futureHostSetting"]) expect(result).not.toHaveProperty(key);
    expect(result).toMatchObject({ engine: "cli", timeoutSec: 120, dangerouslyBypassApprovalsAndSandbox: false });
  });

  it("does not reuse an old account's environment when the connection changes", () => {
    const result = preserveLocalSetupRuntimeConfig({ env: { NEW_TOKEN: "new-account" } }, { ...input,
      aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } });
    expect(result.env).toEqual({ NEW_TOKEN: "new-account" });
  });

  it("recognizes the same connection with differently ordered fields and applies explicit env edits", () => {
    const result = preserveLocalSetupRuntimeConfig({ env: { SystemRoot: "D:\\Windows" } }, { ...input,
      aiConnection: { mode: "responsible_user", method: "subscription", provider: "openai" } });
    expect(result.env).toEqual({ ...saved.adapterConfig.env, SystemRoot: "D:\\Windows" });
  });

  it("keeps the legacy sandbox restriction effective instead of adding a conflicting bypass default", () => {
    const result = preserveLocalSetupRuntimeConfig({ dangerouslyBypassApprovalsAndSandbox: true }, { ...input,
      saved: { ...saved, adapterConfig: { dangerouslyBypassSandbox: false } } });
    expect(result).toEqual({ dangerouslyBypassSandbox: false });
  });

  it.each(["/usr/local/bin/codex", "/Applications/Provider App/bin/codex", "C:\\Tools\\codex.exe"])("retains a configured host command %s", (command) => {
    expect(preserveLocalSetupRuntimeConfig({}, { ...input, saved: { ...saved, adapterConfig: { command } } }).command).toBe(command);
  });

  it("keeps new drafts at their generated defaults", () => {
    const config = { model: "new-model", timeoutSec: 0 };
    expect(preserveLocalSetupRuntimeConfig(config, { ...input, saved: null })).toEqual(config);
  });
});
