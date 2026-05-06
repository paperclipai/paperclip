import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  beforeEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
  });

  afterEach(() => {
    unregisterServerAdapter("external_test");
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
    hermesExecuteMock.mockClear();
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
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain(
      "Authorization: Bearer $PAPERCLIP_API_KEY",
    );
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain(
      "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID",
    );
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("Existing prompt");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain(
      "Avoid shell patterns that trigger interactive safety prompts",
    );
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("curl | python");
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

  it("passes the original Hermes context through when authToken is absent", async () => {
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
    expect(hermesExecuteMock).toHaveBeenCalledWith(ctx);
  });

  it("preserves an explicit Hermes Paperclip API key and injects the active-assignment guard", async () => {
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
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("Paperclip active assignment rule");
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toContain("Do not answer only with acknowledgement");
  });

  it("injects assigned issue and continuation context into Hermes even when no custom template is configured", async () => {
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
      context: {
        paperclipTaskMarkdown: "Issue: BOO-34\nTitle: Resume Bookforge safely",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { identifier: "BOO-34", title: "Resume Bookforge safely" },
        },
        paperclipContinuationSummary: {
          body: "Fix Chapter 13 quality hold, then resume exact queue item only after verification.",
        },
      },
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const prompt = patchedCtx.agent.adapterConfig.promptTemplate;
    expect(prompt).toContain("Paperclip active assignment rule");
    expect(prompt).toContain("Issue: BOO-34");
    expect(prompt).toContain("Resume Bookforge safely");
    expect(prompt).toContain("Paperclip wake payload JSON");
    expect(prompt).toContain("Fix Chapter 13 quality hold");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("agent-run-jwt");
  });

  it("injects bounded Hermes instruction files and directories into the prompt", async () => {
    const adapter = requireServerAdapter("hermes_local");
    const instructionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-instructions-"));
    const directFile = path.join(instructionRoot, "ceo.md");
    const directoryFile = path.join(instructionRoot, "bookforge.txt");
    const ignoredFile = path.join(instructionRoot, "secret.json");
    await fs.writeFile(directFile, "CEO long instruction: read from file, do not paste giant issue.");
    await fs.writeFile(directoryFile, "Bookforge instruction directory content.");
    await fs.writeFile(ignoredFile, "This JSON file should not be injected.");

    try {
      await adapter.execute({
        runId: "run-123",
        agent: {
          id: "agent-123",
          companyId: "company-123",
          name: "Hermes Agent",
          role: "engineer",
          adapterType: "hermes_local",
          adapterConfig: {
            instructionsFilePath: directFile,
            instructionsDirectory: instructionRoot,
          },
        },
        runtime: {},
        config: {},
        context: {
          paperclipTaskMarkdown: "Issue: BOO-58\nTitle: General Instructions",
        },
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
        authToken: "agent-run-jwt",
      });

      const [patchedCtx] = hermesExecuteMock.mock.calls[0];
      const prompt = patchedCtx.agent.adapterConfig.promptTemplate;
      expect(prompt).toContain("Paperclip external instruction references");
      expect(prompt).toContain(`Instruction file: ${directFile}`);
      expect(prompt).toContain(`Instruction file: ${directoryFile}`);
      expect(prompt).toContain("CEO long instruction");
      expect(prompt).toContain("Bookforge instruction directory content");
      expect(prompt).not.toContain("This JSON file should not be injected");
    } finally {
      await fs.rm(instructionRoot, { recursive: true, force: true });
    }
  });

  it("gives Bookforge Lab Hermes agents write/test access to the Bookforge repo with yolo command execution", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "2925a47a-961a-4212-8b36-ce711e2f6ec0",
        name: "Bookforge Forgewright",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: {
        paperclipTaskMarkdown: "Issue: BOO-99\nTitle: Improve Bookforge prompts and tests",
      },
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const adapterConfig = patchedCtx.agent.adapterConfig;
    expect(adapterConfig.cwd).toBe("/Users/begilhan/Bookforge V2 PublicationForge");
    expect(adapterConfig.toolsets).toBe("terminal,file,skills,session_search");
    expect(adapterConfig.timeoutSec).toBe(900);
    expect(adapterConfig.maxTurnsPerRun).toBe(40);
    expect(adapterConfig.extraArgs).toContain("--yolo");
    expect(adapterConfig.env.HERMES_YOLO_MODE).toBe("1");
    expect(adapterConfig.env.PAPERCLIP_API_KEY).toBe("agent-run-jwt");
    expect(adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(adapterConfig.promptTemplate).toContain("you may read, write, and modify code, prompts, tests");
    expect(adapterConfig.promptTemplate).toContain("does not by itself authorize deleting manuscript work");
  });

  it("allows Bookforge Lab code access to be explicitly disabled per agent", async () => {
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "2925a47a-961a-4212-8b36-ce711e2f6ec0",
        name: "Bookforge Checkpoint",
        role: "checkpoint",
        adapterType: "hermes_local",
        adapterConfig: { bookforgeCodeAccess: false },
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
    expect(patchedCtx.agent.adapterConfig.cwd).toBeUndefined();
    expect(patchedCtx.agent.adapterConfig.extraArgs).toBeUndefined();
    expect(patchedCtx.agent.adapterConfig.env.HERMES_YOLO_MODE).toBeUndefined();
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("agent-run-jwt");
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
