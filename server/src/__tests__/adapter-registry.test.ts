import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildSandboxNpmInstallCommand } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "../adapters/index.js";

import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  listAdapterModelProfiles,
  registerServerAdapter,
  requireServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import {
  resolveExternalAdapterRegistration,
  setOverridePaused,
} from "../adapters/registry.js";

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  }),
  testEnvironment: async () => ({
    adapterType: "external_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  models: [{ id: "external-model", label: "External Model" }],
  supportsLocalAgentJwt: false,
};

describe("server adapter registry", () => {
  beforeEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("hermes_local");
    unregisterServerAdapter("hermes_gateway");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
  });

  afterEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("hermes_local");
    unregisterServerAdapter("hermes_gateway");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
  });

  it("registers external adapters and exposes them through lookup helpers", async () => {
    expect(findServerAdapter("external_test")).toBeNull();

    registerServerAdapter(externalAdapter);

    expect(requireServerAdapter("external_test")).toBe(externalAdapter);
    expect(await listAdapterModels("external_test")).toEqual([
      { id: "external-model", label: "External Model" },
    ]);
  });

  it("exposes adapter model profiles when adapters declare them", async () => {
    const adapterWithProfiles: ServerAdapterModule = {
      ...externalAdapter,
      modelProfiles: [
        {
          key: "cheap",
          label: "Cheap",
          adapterConfig: { model: "external-mini" },
          source: "adapter_default",
        },
      ],
    };

    registerServerAdapter(adapterWithProfiles);

    expect(await listAdapterModelProfiles("external_test")).toEqual([
      {
        key: "cheap",
        label: "Cheap",
        adapterConfig: { model: "external-mini" },
        source: "adapter_default",
      },
    ]);
  });

  it("removes external adapters when unregistered", () => {
    registerServerAdapter(externalAdapter);

    unregisterServerAdapter("external_test");

    expect(findServerAdapter("external_test")).toBeNull();
    expect(() => requireServerAdapter("external_test")).toThrow(
      "Unknown adapter type: external_test",
    );
  });

  it("allows external plugin to override a built-in adapter type", () => {
    // claude_local is always built-in
    const builtIn = findServerAdapter("claude_local");
    expect(builtIn).not.toBeNull();

    const plugin: ServerAdapterModule = {
      type: "claude_local",
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      models: [{ id: "plugin-model", label: "Plugin Override" }],
      supportsLocalAgentJwt: false,
    };

    registerServerAdapter(plugin);

    // Plugin wins
    const resolved = requireServerAdapter("claude_local");
    expect(resolved).toBe(plugin);
    expect(resolved.models).toEqual([
      { id: "plugin-model", label: "Plugin Override" },
    ]);
  });

  it("ships Hermes adapters as built-ins and still accepts external overrides", () => {
    const builtInLocal = findServerAdapter("hermes_local");
    const builtInGateway = findServerAdapter("hermes_gateway");

    expect(builtInLocal).not.toBeNull();
    expect(builtInLocal?.supportsLocalAgentJwt).toBe(true);
    expect(builtInLocal?.supportsInstructionsBundle).toBe(true);
    expect(builtInLocal?.requiresMaterializedRuntimeSkills).toBe(false);
    expect(builtInLocal?.detectModel).toBeTypeOf("function");
    expect(builtInLocal?.getConfigSchema).toBeTypeOf("function");

    expect(builtInGateway).not.toBeNull();
    expect(builtInGateway?.supportsLocalAgentJwt).toBe(false);
    expect(builtInGateway?.supportsInstructionsBundle).toBe(false);
    expect(builtInGateway?.requiresMaterializedRuntimeSkills).toBe(false);
    expect(builtInGateway?.getConfigSchema).toBeTypeOf("function");

    const hermesLocalExternalAdapter: ServerAdapterModule = {
      type: "hermes_local",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "hermes_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: true,
      supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath",
      requiresMaterializedRuntimeSkills: false,
      listSkills: async () => ({
        adapterType: "hermes_local",
        supported: true,
        mode: "ephemeral",
        desiredSkills: [],
        entries: [],
        warnings: [],
      }),
      getConfigSchema: () => ({ fields: [{ key: "provider", label: "Provider", type: "text" }] }),
      detectModel: async () => ({
        model: "hermes-model",
        provider: "openrouter",
        source: "test",
      }),
    };

    const hermesGatewayExternalAdapter: ServerAdapterModule = {
      type: "hermes_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "hermes_gateway",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: false,
      supportsInstructionsBundle: false,
      requiresMaterializedRuntimeSkills: false,
      getConfigSchema: () => ({
        fields: [{ key: "apiBaseUrl", label: "API URL", type: "text" }],
      }),
    };

    registerServerAdapter(hermesLocalExternalAdapter);

    expect(requireServerAdapter("hermes_local")).toBe(hermesLocalExternalAdapter);
    expect(findActiveServerAdapter("hermes_local")?.supportsLocalAgentJwt).toBe(true);

    unregisterServerAdapter("hermes_local");

    expect(requireServerAdapter("hermes_local")).toBe(builtInLocal);

    registerServerAdapter(hermesGatewayExternalAdapter);

    expect(requireServerAdapter("hermes_gateway")).toBe(hermesGatewayExternalAdapter);
    expect(findActiveServerAdapter("hermes_gateway")?.supportsLocalAgentJwt).toBe(false);

    unregisterServerAdapter("hermes_gateway");

    expect(requireServerAdapter("hermes_gateway")).toBe(builtInGateway);
  });

  it("exposes capability flags from registered adapters", () => {
    const adapterWithCaps: ServerAdapterModule = {
      type: "external_test",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "external_test",
        status: "pass" as const,
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: true,
      supportsInstructionsBundle: true,
      instructionsPathKey: "customPathKey",
      requiresMaterializedRuntimeSkills: true,
    };

    registerServerAdapter(adapterWithCaps);

    const resolved = findActiveServerAdapter("external_test");
    expect(resolved).not.toBeNull();
    expect(resolved!.supportsInstructionsBundle).toBe(true);
    expect(resolved!.instructionsPathKey).toBe("customPathKey");
    expect(resolved!.requiresMaterializedRuntimeSkills).toBe(true);
    expect(resolved!.supportsLocalAgentJwt).toBe(true);
  });

  it("returns undefined for capability flags on adapters that do not set them", () => {
    registerServerAdapter(externalAdapter);

    const resolved = findActiveServerAdapter("external_test");
    expect(resolved).not.toBeNull();
    expect(resolved!.supportsInstructionsBundle).toBeUndefined();
    expect(resolved!.instructionsPathKey).toBeUndefined();
    expect(resolved!.requiresMaterializedRuntimeSkills).toBeUndefined();
  });

  it("built-in claude_local adapter declares capability flags", () => {
    const adapter = findActiveServerAdapter("claude_local");
    expect(adapter).not.toBeNull();
    expect(adapter!.supportsInstructionsBundle).toBe(true);
    expect(adapter!.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter!.requiresMaterializedRuntimeSkills).toBe(false);
    expect(adapter!.supportsLocalAgentJwt).toBe(true);
  });

  it("built-in local adapters declare cheap model profile defaults where supported", async () => {
    await expect(listAdapterModelProfiles("claude_local")).resolves.toEqual([
      expect.objectContaining({
        key: "cheap",
        adapterConfig: expect.objectContaining({ model: "claude-sonnet-4-6" }),
        source: "adapter_default",
      }),
    ]);
    await expect(listAdapterModelProfiles("codex_local")).resolves.toEqual([
      expect.objectContaining({
        key: "cheap",
        adapterConfig: expect.objectContaining({ model: "gpt-5.3-codex-spark" }),
        source: "adapter_default",
      }),
    ]);
    await expect(listAdapterModelProfiles("gemini_local")).resolves.toEqual([
      expect.objectContaining({
        key: "cheap",
        adapterConfig: expect.objectContaining({ model: "gemini-2.5-flash-lite" }),
        source: "adapter_default",
      }),
    ]);
    await expect(listAdapterModelProfiles("opencode_local")).resolves.toEqual([
      expect.objectContaining({
        key: "cheap",
        adapterConfig: expect.objectContaining({ model: "openai/gpt-5.1-codex-mini" }),
        source: "adapter_default",
      }),
    ]);
    await expect(listAdapterModelProfiles("cursor")).resolves.toEqual([
      expect.objectContaining({
        key: "cheap",
        adapterConfig: expect.objectContaining({ model: "gpt-5.1-codex-mini" }),
        source: "adapter_default",
      }),
    ]);
    await expect(listAdapterModelProfiles("pi_local")).resolves.toEqual([]);
  });

  it("wraps built-in npm runtime installs with the sandbox-aware install helper", () => {
    const expectedClaudeInstall = `if ! command -v 'claude' >/dev/null 2>&1; then ${buildSandboxNpmInstallCommand("@anthropic-ai/claude-code")}; fi`;
    const expectedCodexInstall = `if ! command -v 'codex' >/dev/null 2>&1; then ${buildSandboxNpmInstallCommand("@openai/codex")}; fi`;
    const expectedGeminiInstall = `if ! command -v 'gemini' >/dev/null 2>&1; then ${buildSandboxNpmInstallCommand("@google/gemini-cli")}; fi`;
    const expectedOpenCodeInstall = `if ! command -v 'opencode' >/dev/null 2>&1; then ${buildSandboxNpmInstallCommand("opencode-ai")}; fi`;

    expect(findActiveServerAdapter("claude_local")?.getRuntimeCommandSpec?.({})).toEqual({
      command: "claude",
      detectCommand: "claude",
      installCommand: expectedClaudeInstall,
    });
    expect(findActiveServerAdapter("codex_local")?.getRuntimeCommandSpec?.({})).toEqual({
      command: "codex",
      detectCommand: "codex",
      installCommand: expectedCodexInstall,
    });
    expect(findActiveServerAdapter("gemini_local")?.getRuntimeCommandSpec?.({})).toEqual({
      command: "gemini",
      detectCommand: "gemini",
      installCommand: expectedGeminiInstall,
    });
    expect(findActiveServerAdapter("opencode_local")?.getRuntimeCommandSpec?.({})).toEqual({
      command: "opencode",
      detectCommand: "opencode",
      installCommand: expectedOpenCodeInstall,
    });
  });

  it("switches active adapter behavior back to the builtin when an override is paused", async () => {
    const builtIn = findServerAdapter("claude_local");
    expect(builtIn).not.toBeNull();

    const detectModel = vi.fn(async () => ({
      model: "plugin-model",
      provider: "plugin-provider",
      source: "plugin-source",
    }));
    const plugin: ServerAdapterModule = {
      type: "claude_local",
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      models: [{ id: "plugin-model", label: "Plugin Override" }],
      detectModel,
      supportsLocalAgentJwt: false,
    };

    registerServerAdapter(plugin);

    expect(findActiveServerAdapter("claude_local")).toBe(plugin);
    expect(await listAdapterModels("claude_local")).toEqual([
      { id: "plugin-model", label: "Plugin Override" },
    ]);
    expect(await detectAdapterModel("claude_local")).toMatchObject({
      model: "plugin-model",
      provider: "plugin-provider",
    });

    expect(setOverridePaused("claude_local", true)).toBe(true);

    expect(findActiveServerAdapter("claude_local")).not.toBe(plugin);
    expect(await listAdapterModels("claude_local")).toEqual(builtIn?.models ?? []);
    expect(await detectAdapterModel("claude_local")).toBeNull();
    expect(detectModel).toHaveBeenCalledTimes(1);
  });
});

describe("resolveExternalAdapterRegistration", () => {
  it("preserves module-provided sessionManagement", () => {
    const sessionManagement = {
      supportsSessionResume: true,
      nativeContextManagement: "unknown" as const,
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 200,
        maxRawInputTokens: 2_000_000,
        maxSessionAgeHours: 72,
      },
    };
    const adapter: ServerAdapterModule = {
      type: "external_session_test",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "external_session_test",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      sessionManagement,
    };

    const resolved = resolveExternalAdapterRegistration(adapter);

    expect(resolved.sessionManagement).toBe(sessionManagement);
  });

  it("falls back to the hardcoded registry when the module omits sessionManagement", () => {
    // An external that overrides a built-in type should inherit the built-in's
    // sessionManagement when it does not provide its own.
    const adapter: ServerAdapterModule = {
      type: "claude_local",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    };

    const resolved = resolveExternalAdapterRegistration(adapter);

    expect(resolved.sessionManagement).toBeDefined();
    expect(resolved.sessionManagement?.supportsSessionResume).toBe(true);
    expect(resolved.sessionManagement?.nativeContextManagement).toBe("confirmed");
  });

  it("leaves sessionManagement undefined when neither module nor registry provides one", () => {
    const adapter: ServerAdapterModule = {
      type: "external_unknown_test",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "external_unknown_test",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    };

    const resolved = resolveExternalAdapterRegistration(adapter);

    expect(resolved.sessionManagement).toBeUndefined();
  });
});
