import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const hermesExecuteMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  })),
);

// Default: no bundle configured. The real exportFiles() legacy fallback never returns
// { files: {} } — when neither instructionsRootPath nor instructionsFilePath is set it
// returns config.promptTemplate as { "AGENTS.md": <promptTemplate> } (or a placeholder
// sentinel string). With the gate in registry.ts, exportFiles() is NOT called for agents
// without explicit bundle config keys, so this default is only reached by tests that set
// instructionsRootPath/instructionsFilePath and don't override via mockResolvedValueOnce.
// Individual tests that exercise the bundle path override via mockResolvedValueOnce().
const agentInstructionsExportFilesMock = vi.hoisted(() =>
  vi.fn(async () => ({
    files: { "AGENTS.md": "Default mock bundle content." } as Record<string, string>,
    entryFile: "AGENTS.md",
    warnings: [] as string[],
  })),
);

// Default fs mock: stat returns a non-empty file, readdir returns a non-empty listing.
// This keeps existing bundle tests passing — they set instructionsRootPath/instructionsFilePath
// to fake paths that don't exist on disk, so fs calls must be intercepted.
// Tests that exercise missing/empty paths override via mockRejectedValueOnce / mockResolvedValueOnce.
const fsStatMock = vi.hoisted(() =>
  vi.fn(async (_path: unknown) => ({
    isFile: () => true,
    size: 1024,
  })),
);
const fsReaddirMock = vi.hoisted(() =>
  vi.fn(async (_path: unknown) => ["AGENTS.md"] as string[]),
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...(actual as Record<string, unknown>),
      stat: fsStatMock,
      readdir: fsReaddirMock,
    },
    stat: fsStatMock,
    readdir: fsReaddirMock,
  };
});

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

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => ({
    exportFiles: agentInstructionsExportFilesMock,
  }),
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
    agentInstructionsExportFilesMock.mockClear();
    fsStatMock.mockClear();
    fsReaddirMock.mockClear();
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

  it("prepends instructions bundle content to promptTemplate when bundle files are present", async () => {
    agentInstructionsExportFilesMock.mockResolvedValueOnce({
      files: {
        "AGENTS.md": "You are a helpful agent.",
        "SOUL.md": "Be empathetic.",
      },
      entryFile: "AGENTS.md",
      warnings: [],
    });

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-456",
        companyId: "company-123",
        name: "Hermes Bundle Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsRootPath: "/srv/agents/agent-456/instructions",
          promptTemplate: "Custom base prompt",
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
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // Entry file (AGENTS.md) appears before other bundle files.
    expect(promptTemplate.indexOf("# AGENTS.md")).toBeLessThan(promptTemplate.indexOf("# SOUL.md"));
    // Bundle content present.
    expect(promptTemplate).toContain("You are a helpful agent.");
    expect(promptTemplate).toContain("Be empathetic.");
    // Original promptTemplate preserved at the end.
    expect(promptTemplate).toContain("Custom base prompt");
    expect(promptTemplate.indexOf("Custom base prompt")).toBeGreaterThan(promptTemplate.indexOf("Be empathetic."));
  });

  it("prepends instructions bundle content to promptTemplate when instructionsFilePath is set (UI-configured path)", async () => {
    agentInstructionsExportFilesMock.mockResolvedValueOnce({
      files: {
        "AGENTS.md": "Bundle content via filePath",
        "SOUL.md": "Voice content",
      },
      entryFile: "AGENTS.md",
      warnings: [],
    });

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-filepath",
        companyId: "company-123",
        name: "Hermes FilePath Bundle Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsFilePath: "/some/path/AGENTS.md",
          promptTemplate: "Custom base prompt via filePath",
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

    // exportFiles() must have been called — the gate passes via instructionsFilePath.
    expect(agentInstructionsExportFilesMock).toHaveBeenCalledTimes(1);
    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // Entry file (AGENTS.md) appears before other bundle files.
    expect(promptTemplate.indexOf("# AGENTS.md")).toBeLessThan(promptTemplate.indexOf("# SOUL.md"));
    // Bundle content present.
    expect(promptTemplate).toContain("Bundle content via filePath");
    expect(promptTemplate).toContain("Voice content");
    // Original promptTemplate preserved at the end.
    expect(promptTemplate).toContain("Custom base prompt via filePath");
    expect(promptTemplate.indexOf("Custom base prompt via filePath")).toBeGreaterThan(
      promptTemplate.indexOf("Voice content"),
    );
  });

  it("injects bundle content as promptTemplate when no custom template was set, without stripping Hermes default", async () => {
    agentInstructionsExportFilesMock.mockResolvedValueOnce({
      files: {
        "AGENTS.md": "Agent role instructions.",
      },
      entryFile: "AGENTS.md",
      warnings: [],
    });

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-789",
      agent: {
        id: "agent-789",
        companyId: "company-123",
        name: "Hermes Bundle Agent No Template",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsRootPath: "/srv/agents/agent-789/instructions",
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
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    expect(promptTemplate).toContain("Agent role instructions.");
  });

  it("does not inject bundle content when no instructionsRootPath or instructionsFilePath is set", async () => {
    // No instructionsRootPath / instructionsFilePath in adapterConfig — the gate in
    // registry.ts skips exportFiles() entirely. The real legacy fallback would have
    // returned promptTemplate as { "AGENTS.md": <promptTemplate> }, which without the
    // gate would cause promptTemplate to appear twice in the final prompt.
    // exportFiles() must NOT be called for this agent.
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-no-bundle",
        companyId: "company-123",
        name: "Hermes No Bundle Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          promptTemplate: "Only template, no bundle",
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

    // exportFiles() must not have been called — the gate prevents the legacy-fallback
    // duplication and placeholder-injection bugs.
    expect(agentInstructionsExportFilesMock).not.toHaveBeenCalled();

    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // Original promptTemplate preserved, not duplicated.
    expect(promptTemplate).toContain("Only template, no bundle");
    const occurrences = (promptTemplate.match(/Only template, no bundle/g) ?? []).length;
    expect(occurrences).toBe(1);
    // No bundle section headers injected.
    expect(promptTemplate).not.toContain("# AGENTS.md");
  });

  it("skips bundle injection when instructionsRootPath is set but directory does not exist (ENOENT)", async () => {
    // Simulate operator pre-configuring the path before the bundle is materialized.
    // readdir rejects with ENOENT — bundleAvailable stays false, exportFiles is NOT called.
    // The legacy fallback in exportFiles would have returned { "AGENTS.md": promptTemplate },
    // causing promptTemplate to appear twice. The gate prevents that.
    fsReaddirMock.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-enoent-dir",
      agent: {
        id: "agent-missing-dir",
        companyId: "company-123",
        name: "Hermes Missing Dir Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsRootPath: "/srv/agents/missing-dir/instructions",
          promptTemplate: "Template with missing bundle dir",
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

    // exportFiles must NOT be called — the gate skips injection when the path is missing.
    expect(agentInstructionsExportFilesMock).not.toHaveBeenCalled();

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // promptTemplate appears exactly once — no duplication from legacy fallback.
    const occurrences = (promptTemplate.match(/Template with missing bundle dir/g) ?? []).length;
    expect(occurrences).toBe(1);
    // No bundle section header injected.
    expect(promptTemplate).not.toContain("# AGENTS.md");
  });

  it("skips bundle injection when instructionsRootPath is set but directory is empty", async () => {
    // readdir resolves to an empty array — bundleAvailable stays false, exportFiles is NOT called.
    fsReaddirMock.mockResolvedValueOnce([]);

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-empty-dir",
      agent: {
        id: "agent-empty-dir",
        companyId: "company-123",
        name: "Hermes Empty Dir Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsRootPath: "/srv/agents/empty-dir/instructions",
          promptTemplate: "Template with empty bundle dir",
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

    // exportFiles must NOT be called — the gate skips injection when the directory is empty.
    expect(agentInstructionsExportFilesMock).not.toHaveBeenCalled();

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // promptTemplate appears exactly once — no duplication from legacy fallback.
    const occurrences = (promptTemplate.match(/Template with empty bundle dir/g) ?? []).length;
    expect(occurrences).toBe(1);
    // No bundle section header injected.
    expect(promptTemplate).not.toContain("# AGENTS.md");
  });

  it("skips bundle injection when instructionsFilePath is set but file does not exist (ENOENT)", async () => {
    // stat rejects with ENOENT — bundleAvailable stays false, exportFiles is NOT called.
    fsStatMock.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));

    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute({
      runId: "run-enoent-file",
      agent: {
        id: "agent-missing-file",
        companyId: "company-123",
        name: "Hermes Missing File Agent",
        role: "general",
        adapterType: "hermes_local",
        adapterConfig: {
          instructionsFilePath: "/srv/agents/missing-file/AGENTS.md",
          promptTemplate: "Template with missing bundle file",
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

    // exportFiles must NOT be called — the gate skips injection when the file is missing.
    expect(agentInstructionsExportFilesMock).not.toHaveBeenCalled();

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];
    const { promptTemplate } = patchedCtx.agent.adapterConfig;
    // Auth guard present.
    expect(promptTemplate).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    // promptTemplate appears exactly once — no duplication from legacy fallback.
    const occurrences = (promptTemplate.match(/Template with missing bundle file/g) ?? []).length;
    expect(occurrences).toBe(1);
    // No bundle section header injected.
    expect(promptTemplate).not.toContain("# AGENTS.md");
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
