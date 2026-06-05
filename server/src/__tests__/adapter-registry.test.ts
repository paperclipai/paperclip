import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSandboxNpmInstallCommand } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "../adapters/index.js";

const hermesExecuteMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  })),
);

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: hermesExecuteMock,
  testEnvironment: async () => ({
    adapterType: "hermes_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  sessionCodec: null,
  listSkills: async () => [],
  syncSkills: async () => ({ entries: [] }),
  detectModel: async () => null,
}));

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
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
  });

  afterEach(async () => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
    hermesExecuteMock.mockClear();
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  async function createRuntimeSkill(key: string, body: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-skill-"));
    cleanupDirs.add(root);
    const skillDir = path.join(root, key);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
    return skillDir;
  }

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

  it("injects the local agent JWT and Paperclip API auth guidance into Hermes", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: "llm-token",
          },
          promptTemplate: "Existing prompt",
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.agent.adapterConfig).toMatchObject({
      env: {
        OPENAI_API_KEY: "llm-token",
        PAPERCLIP_API_KEY: "agent-run-jwt",
        PAPERCLIP_RUN_ID: "run-123",
      },
    });
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toBeUndefined();
    expect(patchedCtx.config.taskBody).toContain(
      "Authorization: Bearer $PAPERCLIP_API_KEY",
    );
    expect(patchedCtx.config.taskBody).toContain(
      "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID",
    );
    expect(patchedCtx.config.taskBody).toContain("Existing prompt");
  });

  it("preserves Hermes command normalization while injecting auth", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          command: "agent-hermes",
        },
      },
      runtime: {},
      config: {
        command: "runtime-hermes",
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.config.hermesCommand).toBe("runtime-hermes");
    expect(patchedCtx.agent.adapterConfig.hermesCommand).toBe("agent-hermes");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("agent-run-jwt");
  });

  it("still applies Hermes task-body guidance when authToken is absent but an explicit API key exists", async () => {
    const adapter = requireServerAdapter("hermes_local");
    const ctx = {
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          env: {
            PAPERCLIP_API_KEY: "server-level-key",
          },
          promptTemplate: "Existing prompt",
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    };

    await adapter.execute(ctx);

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("server-level-key");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toBeUndefined();
    expect(patchedCtx.config.taskBody).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    expect(patchedCtx.config.taskBody).toContain("Existing prompt");
  });

  it("preserves an explicit Hermes Paperclip API key and does not set promptTemplate when none was configured", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          env: {
            PAPERCLIP_API_KEY: "explicit-agent-key",
            PAPERCLIP_RUN_ID: "stale-run-id",
          },
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("explicit-agent-key");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-123");
    // No custom promptTemplate was set — Hermes must use its built-in default.
    // Setting promptTemplate here would replace the full default with just the auth guard text,
    // stripping assigned issue / workflow instructions.
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toBeUndefined();
  });

  it("does not set promptTemplate when no custom template is configured, preserving Hermes default", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    // promptTemplate must remain unset so Hermes uses its built-in heartbeat/task prompt.
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toBeUndefined();
    // Auth token is still injected.
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("agent-run-jwt");
  });

  it("appends desired Paperclip runtime skills and makes the final key table contract last for proof tasks", async () => {
    const adapter = requireServerAdapter("hermes_local");
    const skillDir = await createRuntimeSkill(
      "requirements-analysis",
      "# Requirements Analysis\n\nAlways summarize requirements, blockers, and next safe step.",
    );

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: ["requirements-analysis"],
          },
        },
      },
      runtime: {},
      config: {
        taskBody: "Original Sandbox/Test issue body. Please include Paperclip runtime capability keys.",
        paperclipRuntimeSkills: [
          {
            key: "requirements-analysis",
            runtimeName: "requirements-analysis",
            source: skillDir,
          },
        ],
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("## Final Required Output Contract");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain(
      "- requirements-analysis: used OR visible but not used",
    );
    expect(patchedCtx.config.taskBody).toContain("Original Sandbox/Test issue body.");
    expect(patchedCtx.config.taskBody).toContain("## Paperclip Runtime Capability Keys");
    expect(patchedCtx.config.taskBody).toContain("If, and only if, the assigned issue explicitly asks");
    expect(patchedCtx.config.taskBody).toContain("PAPERCLIP_RUNTIME_CAPABILITY_KEYS");
    expect(patchedCtx.config.taskBody).toContain("requirements-analysis");
    expect(patchedCtx.config.taskBody).toContain("Always summarize requirements");
    expect(patchedCtx.agent.adapterConfig.promptTemplate.indexOf("## Response Workflow")).toBeLessThan(
      patchedCtx.agent.adapterConfig.promptTemplate.indexOf("## Final Required Output Contract"),
    );
  });

  it("copies Paperclip issue context into Hermes task config when heartbeat only provides context", async () => {
    const adapter = requireServerAdapter("hermes_local");
    const onLog = vi.fn(async () => {});
    const skillDir = await createRuntimeSkill(
      "requirements-analysis",
      "# Requirements Analysis\n\nAlways summarize requirements, blockers, and next safe step.",
    );

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: ["requirements-analysis"],
          },
        },
      },
      runtime: {},
      config: {
        paperclipRuntimeSkills: [
          {
            key: "requirements-analysis",
            runtimeName: "requirements-analysis",
            source: skillDir,
          },
        ],
      },
      context: {
        paperclipIssue: {
          id: "issue-uuid",
          identifier: "AI-98231",
          title: "Hermes taskBody runtime skill prompt proof",
          description: "Fallback issue description.",
        },
        paperclipTaskMarkdown: "## Paperclip Issue\n\nAI-98231 runtime proof body. Include Paperclip runtime capability keys.",
      },
      onLog,
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.config.taskId).toBe("AI-98231");
    expect(patchedCtx.config.taskTitle).toBe("Hermes taskBody runtime skill prompt proof");
    expect(patchedCtx.config.taskBody).toContain("AI-98231 runtime proof body.");
    expect(patchedCtx.config.taskBody).toContain("## Paperclip Runtime Capability Keys");
    expect(patchedCtx.config.taskBody).toContain("requirements-analysis");
    expect(patchedCtx.config.taskBody).toContain("Always summarize requirements");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("## Final Required Output Contract");
    const routingLog = onLog.mock.calls.find(([stream]) => stream === "stdout")?.[1] as string | undefined;
    expect(routingLog).toContain("[paperclip] Hermes prompt routing:");
    expect(routingLog).toContain("taskId=true");
    expect(routingLog).toContain("taskBody=true");
    expect(routingLog).toContain("runtimeSkills=true");
  });

  it("moves custom Hermes prompt templates into the task body with Paperclip runtime skills without overriding ordinary deliverables", async () => {
    const adapter = requireServerAdapter("hermes_local");
    const onLog = vi.fn(async () => {});
    const skillDir = await createRuntimeSkill(
      "quality-check",
      "# Quality Check\n\nAlways list tested behavior and remaining risk.",
    );

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          promptTemplate: "Existing prompt",
          paperclipSkillSync: {
            desiredSkills: ["quality-check"],
          },
        },
      },
      runtime: {},
      config: {
        paperclipRuntimeSkills: [
          {
            key: "quality-check",
            runtimeName: "quality-check",
            source: skillDir,
          },
        ],
      },
      context: {},
      onLog,
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    expect(patchedCtx.agent.adapterConfig.promptTemplate).not.toContain("## Final Required Output Contract");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("## Response Workflow");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("Paperclip will post your final response back to the issue automatically");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).not.toContain("curl -s -X POST");
    expect(patchedCtx.config.taskBody).toContain(
      "Authorization: Bearer $PAPERCLIP_API_KEY",
    );
    expect(patchedCtx.config.taskBody).toContain("## Paperclip Runtime Capability Keys");
    expect(patchedCtx.config.taskBody).toContain("If, and only if, the assigned issue explicitly asks");
    expect(patchedCtx.config.taskBody).toContain("PAPERCLIP_RUNTIME_CAPABILITY_KEYS");
    expect(patchedCtx.config.taskBody).toContain("quality-check");
    expect(patchedCtx.config.taskBody).not.toContain("Always list tested behavior");
    expect(patchedCtx.config.taskBody).toContain("Detailed skill instructions are hidden for this ordinary task");
    expect(patchedCtx.config.taskBody).toContain("## Hermes Agent Instructions");
    expect(patchedCtx.config.taskBody).toContain("Existing prompt");
    expect(patchedCtx.config.taskBody.indexOf("## Hermes Agent Instructions")).toBeLessThan(
      patchedCtx.config.taskBody.indexOf("## Paperclip Runtime Capability Keys"),
    );
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining(
        "runtimeSkillsAfterAgentInstructions=true runtimeSkillKeys=quality-check runtimeCapabilityProofRequired=false",
      ),
    );
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
