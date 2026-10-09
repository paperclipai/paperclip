import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentInstructionRevisions,
  agentInstructionHeads,
  agents,
  approvals,
  budgetPolicies,
  companies,
  createDb,
  pluginEntities,
  pluginCompanySettings,
  pluginManagedResources,
  plugins,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { agentService } from "../services/agents.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { pluginRegistryService } from "../services/plugin-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.managed-agents-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Agents Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    agents: [
      {
        agentKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
        role: "engineer",
        title: "Maintains plugin-owned knowledge",
        capabilities: "Maintains a plugin-owned wiki.",
        adapterType: "process",
        adapterConfig: { command: "pnpm wiki:maintain" },
        runtimeConfig: { heartbeat: { enabled: false } },
        permissions: { canCreateAgents: false },
        budgetMonthlyCents: 1234,
      },
    ],
  };
}

function pausedManifest(): PaperclipPluginManifestV1 {
  const pluginManifest = manifest();
  pluginManifest.agents![0] = {
    ...pluginManifest.agents![0]!,
    status: "paused",
  };
  return pluginManifest;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let runnerSelectionSpy: { mockRestore(): void } | undefined;
  const runnerTarget = { driver: "local", platform: "linux", architecture: "x64" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    // Exercise real runner policy on the qualified Linux release target.
    runnerTarget.platform = "linux";
    runnerTarget.architecture = "x64";
    const selection = await import("../services/agent-runner-selection.js");
    runnerSelectionSpy = vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: runnerTarget }));
  });

  afterEach(async () => {
    runnerSelectionSpy?.mockRestore();
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(pluginCompanySettings);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(principalPermissionGrants);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(options: { requireApproval?: boolean; manifest?: PaperclipPluginManifestV1 } = {}) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const pluginManifest = options.manifest ?? manifest();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: options.requireApproval ?? false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-managed-agents-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    return { companyId, pluginId, pluginManifest, services };
  }

  it("creates and resolves managed agents by stable resource key", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();

    const created = await services.agents.managedReconcile({
      companyId,
      agentKey: "wiki-maintainer",
    });

    expect(created.status).toBe("created");
    expect(created.agentId).toBeTruthy();
    expect(created.agent).toMatchObject({
      name: "Wiki Maintainer",
      role: "engineer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });

    const resolved = await services.agents.managedGet({
      companyId,
      agentKey: "wiki-maintainer",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.agentId).toBe(created.agentId);

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.entityType).toBe("managed_agent");
    expect(binding?.scopeKind).toBe("company");
    expect(binding?.scopeId).toBe(companyId);
    expect(binding?.data).toMatchObject({
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      agentId: created.agentId,
    });
  });

  it("preserves user edits during reconcile and resets only on explicit reset", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(created.agentId).toBeTruthy();

    await db
      .update(agents)
      .set({
        name: "Knowledge Lead",
        adapterConfig: { command: "custom" },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, created.agentId!));

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(reconciled.status).toBe("resolved");
    expect(reconciled.agent).toMatchObject({
      name: "Knowledge Lead",
      adapterConfig: { command: "custom" },
    });

    const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
    expect(reset.status).toBe("reset");
    expect(reset.agent).toMatchObject({
      name: "Wiki Maintainer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });
  });

  it("records plugin provenance when a manifest creates a paused managed agent", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.agent).toMatchObject({
      status: "paused",
      pauseReason: "Provisioned paused by plugin paperclip.managed-agents-test; requires explicit activation.",
    });
    expect(created.agent?.pausedAt).toBeInstanceOf(Date);
  });

  it("backfills a legacy null pause reason while the managed declaration and agent remain paused", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    await db
      .update(agents)
      .set({ pauseReason: null, updatedAt: new Date() })
      .where(eq(agents.id, created.agentId!));

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(reconciled.agent).toMatchObject({
      status: "paused",
      pauseReason: "Provisioned paused by plugin paperclip.managed-agents-test; requires explicit activation.",
    });
  });

  it.each(["manual", "budget", "system", "maintenance"])(
    "preserves the existing %s pause reason during reconcile",
    async (pauseReason) => {
      const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      await db
        .update(agents)
        .set({ pauseReason, updatedAt: new Date() })
        .where(eq(agents.id, created.agentId!));

      const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

      expect(reconciled.agent).toMatchObject({ status: "paused", pauseReason });
    },
  );

  it("keeps an explicit resume durable across managed-agent reconcile", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pausedManifest() });
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    await createAgentLifecycle(db).resumeAgent(created.agentId!);

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(reconciled.agent).toMatchObject({ lifecycleState: "resuming", pauseReason: null });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    await worker.process(created.agentId!);
    await worker.stop();
    expect((await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" })).agent).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
  });

  it("creates managed agents with the most-used compatible company adapter", async () => {
    const pluginManifest = manifest();
    pluginManifest.agents![0] = {
      ...pluginManifest.agents![0]!,
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local"],
      adapterConfig: {},
    };
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Codex One",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Codex Two",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Claude One",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(reconciled.agent?.adapterConfig).toEqual(created.agent?.adapterConfig);
    // Reset declaration defaults without requalifying an existing native agent.
    runnerTarget.platform = "darwin";
    runnerTarget.architecture = "arm64";
    const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
    expect(reset.agent).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
  });

  it("materializes declared managed agent instructions with local folder paths", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-home-")));
    const wikiRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-wiki-")));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    try {
      const pluginManifest = manifest();
      pluginManifest.localFolders = [
        {
          folderKey: "wiki-root",
          displayName: "Wiki root",
          access: "readWrite",
          requiredDirectories: [],
          requiredFiles: ["AGENTS.md"],
        },
      ];
      pluginManifest.agents![0] = {
        ...pluginManifest.agents![0]!,
        adapterType: "claude_local",
        adapterConfig: {},
        instructions: {
          entryFile: "AGENTS.md",
          content: [
            "# LLM Wiki Maintainer",
            "",
            "You are the LLM Wiki Maintainer.",
            "Wiki root: `{{localFolders.wiki-root.path}}`",
            "Wiki schema: `{{localFolders.wiki-root.agentsPath}}`",
            "",
          ].join("\n"),
        },
      };
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      await fs.writeFile(path.join(wikiRoot, "AGENTS.md"), "# Wiki schema\n", "utf8");
      await db.insert(pluginCompanySettings).values({
        companyId,
        pluginId,
        enabled: true,
        settingsJson: {
          localFolders: {
            "wiki-root": {
              path: wikiRoot,
              access: "readWrite",
              requiredDirectories: [],
              requiredFiles: ["AGENTS.md"],
            },
          },
        },
      });

      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

      const instructionsFilePath = created.agent?.adapterConfig.instructionsFilePath;
      expect(typeof instructionsFilePath).toBe("string");
      const content = await fs.readFile(instructionsFilePath as string, "utf8");
      expect(content).toContain("You are the LLM Wiki Maintainer.");
      expect(content).toContain(`Wiki root: \`${wikiRoot}\``);
      expect(content).toContain(`Wiki schema: \`${path.join(wikiRoot, "AGENTS.md")}\``);

      // A managed plugin reset must preserve the previous entry in canonical
      // history instead of deleting a shared bundle or bypassing its write guard.
      const edited = "# User-customized wiki instructions\n";
      await fs.writeFile(instructionsFilePath as string, edited);
      const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
      expect(reset.status).toBe("reset");
      expect(await fs.readFile(instructionsFilePath as string, "utf8")).toBe(content);
      const history = await db.select().from(agentInstructionRevisions)
        .where(eq(agentInstructionRevisions.agentId, created.agentId!));
      expect(history).toHaveLength(0);
      expect(await db.select().from(agentInstructionHeads)
        .where(eq(agentInstructionHeads.agentId, created.agentId!))).toHaveLength(0);
      const repeated = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
      expect(repeated.status).toBe("reset");
      expect(await db.select().from(agentInstructionRevisions)
        .where(eq(agentInstructionRevisions.agentId, created.agentId!))).toHaveLength(0);
      const audit = await db.select().from(activityLog).where(eq(activityLog.action, "agent.files_updated"));
      expect(audit).toHaveLength(1);
      expect(audit.every((row) => row.actorType === "plugin" && row.actorId === pluginId)).toBe(true);
      const bundles = agentInstructionsService(db);
      await bundles.writeFile(repeated.agent!, "CUSTOM.md", "# Alternate configured entry\n");
      const switched = await bundles.updateBundle(repeated.agent!, { entryFile: "CUSTOM.md" });
      await agentService(db).update(created.agentId!, { adapterConfig: switched.adapterConfig });
      const resetEntry = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
      expect(resetEntry.agent?.adapterConfig.instructionsEntryFile).toBe("AGENTS.md");
      expect(resetEntry.defaultDrift).toBeNull();
      expect(await fs.readFile(instructionsFilePath as string, "utf8")).toBe(content);
      const preserved = await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, created.agentId!));
      expect(preserved).toHaveLength(0);
      expect(await fs.readFile(path.join(path.dirname(instructionsFilePath as string), "CUSTOM.md"), "utf8")).toBe("# Alternate configured entry\n");


    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(wikiRoot, { recursive: true, force: true });
    }
  });

  it("fences plugin instruction reset by exact ownership, current capability and canonical CAS", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const tempHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-reset-cas-")));
    process.env.PAPERCLIP_HOME = tempHome;
    try {
      const pluginManifest = manifest();
      pluginManifest.agents![0]!.instructions = { content: "# Default\n" };
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      const target = { companyId, agentId: created.agentId! };
      const actor = { type: "plugin" as const, pluginId, pluginKey: pluginManifest.id, agentKey: "wiki-maintainer" };
      const revisions = agentInstructionRevisionService(db);
      const baselineRead = await revisions.readForPluginReset(target, actor);
      const baseline = baselineRead.snapshot!;
      const input = { ...target, entryFile: "AGENTS.md", baseRevisionId: baseline.revision.id,
        configuredEntryFile: baselineRead.configuredEntryFile, content: "# Reset\n" };
      await expect(revisions.commitPluginReset(input, { ...actor, pluginId: randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(revisions.commitPluginReset({ ...input, companyId: randomUUID() }, actor)).rejects.toMatchObject({ status: 404 });
      await expect(revisions.commitPluginReset(input, { ...actor, agentKey: "foreign-agent" })).rejects.toMatchObject({ status: 403 });
      await db.update(plugins).set({ manifestJson: { ...pluginManifest, capabilities: [] } }).where(eq(plugins.id, pluginId));
      await expect(revisions.commitPluginReset(input, actor)).rejects.toMatchObject({ status: 403 });
      await db.update(plugins).set({ manifestJson: pluginManifest }).where(eq(plugins.id, pluginId));
      const originalMetadata = created.agent!.metadata;
      await db.update(agents).set({ metadata: {} }).where(eq(agents.id, target.agentId));
      await expect(revisions.commitPluginReset(input, actor)).rejects.toMatchObject({ status: 403 });
      await db.update(agents).set({ metadata: originalMetadata }).where(eq(agents.id, target.agentId));
      const [binding] = await db.select().from(pluginManagedResources).where(eq(pluginManagedResources.resourceId, target.agentId));
      await db.update(pluginManagedResources).set({ resourceId: randomUUID() }).where(eq(pluginManagedResources.id, binding.id));
      await expect(revisions.commitPluginReset(input, actor)).rejects.toMatchObject({ status: 403 });
      await db.update(pluginManagedResources).set({ resourceId: target.agentId }).where(eq(pluginManagedResources.id, binding.id));
      await expect(revisions.commitPluginReset({ ...input, entryFile: "OTHER.md" }, actor)).rejects.toMatchObject({ status: 403 });
      const bundles = agentInstructionsService(db);
      await bundles.writeFile(created.agent!, "OTHER.md", "# Other entry\n");
      const switched = await bundles.updateBundle(created.agent!, { entryFile: "OTHER.md" });
      await agentService(db).update(target.agentId, { adapterConfig: switched.adapterConfig });
      await expect(revisions.commitPluginReset(input, actor)).rejects.toMatchObject({ status: 409, details: { code: "INSTRUCTION_ENTRY_CHANGED" } });
      await agentService(db).update(target.agentId, { adapterConfig: created.agent!.adapterConfig });
      const results = await Promise.allSettled([
        revisions.commitPluginReset(input, actor),
        revisions.commitPluginReset({ ...input, content: "# Concurrent reset\n" }, actor),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ status: 409, details: { code: "INSTRUCTION_REVISION_CONFLICT" } });
      const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof revisions.commitPluginReset>>>;
      expect(await fs.readFile(created.agent!.adapterConfig.instructionsFilePath as string, "utf8")).toBe(winner.value.content);
      const history = await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, target.agentId));
      expect(history).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("repairs a missing binding by relinking a same-company managed agent marker", async () => {
    const { companyId, pluginId, pluginManifest, services } = await seedCompanyAndPlugin();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Renamed Wiki Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "custom" },
      runtimeConfig: {},
      permissions: {},
      metadata: {
        paperclipManagedResource: {
          pluginId,
          pluginKey: pluginManifest.id,
          resourceKind: "agent",
          resourceKey: "wiki-maintainer",
        },
      },
    });

    const relinked = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(relinked.status).toBe("relinked");
    expect(relinked.agentId).toBe(agentId);
    expect(relinked.agent?.urlKey).toBe("renamed-wiki-agent");

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.data).toMatchObject({ agentId });
  });

  it("preserves current-file authority when relinking after a hard uninstall and reinstall", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const tempHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-reinstall-reset-")));
    process.env.PAPERCLIP_HOME = tempHome;
    try {
      const pluginManifest = manifest();
      pluginManifest.agents![0]!.instructions = { content: "# Original stock\n" };
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      const target = { companyId, agentId: created.agentId! };
      const revisions = agentInstructionRevisionService(db);
      const original = await revisions.readForPluginReset(target, {
        type: "plugin", pluginId, pluginKey: pluginManifest.id, agentKey: "wiki-maintainer",
      });
      const registry = pluginRegistryService(db);
      await registry.uninstall(pluginId, true);
      expect(await db.select().from(pluginManagedResources)).toHaveLength(0);
      expect(await db.select().from(pluginEntities)).toHaveLength(0);
      const nextManifest = structuredClone(pluginManifest);
      nextManifest.agents![0]!.instructions = { content: "# Reinstalled stock\n" };
      const installed = await registry.install({ packageName: "@paperclipai/plugin-managed-agents-test" }, nextManifest);
      expect(installed!.id).not.toBe(pluginId);
      await registry.updateStatus(installed!.id, { status: "ready" });
      const reinstalledServices = buildHostServices(db, installed!.id, nextManifest.id, createEventBusStub(), undefined, {
        manifest: nextManifest,
      });
      const relinked = await reinstalledServices.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      expect(relinked.status).toBe("relinked");
      expect(relinked.agentId).toBe(created.agentId);
      const reset = await reinstalledServices.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
      expect(reset.agentId).toBe(created.agentId);
      expect(reset.agent!.metadata).toMatchObject({ paperclipManagedResource: { pluginId: installed!.id }, pluginManagedAgent: { pluginId: installed!.id } });
      expect(await fs.readFile(reset.agent!.adapterConfig.instructionsFilePath as string, "utf8")).toBe("# Reinstalled stock\n");
      const history = await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, created.agentId!));
      expect(history).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it.each(["not-ready", "capability-removed", "declaration-removed", "other-plugin-owner"])(
    "does not relink a managed agent when its authority is %s", async (reason) => {
      const { companyId, pluginId, pluginManifest, services } = await seedCompanyAndPlugin();
      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
      await db.delete(pluginEntities);
      await db.delete(pluginManagedResources);
      if (reason === "not-ready") {
        await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
      } else if (reason === "capability-removed") {
        await db.update(plugins).set({ manifestJson: { ...pluginManifest, capabilities: [] } }).where(eq(plugins.id, pluginId));
      } else if (reason === "declaration-removed") {
        await db.update(plugins).set({ manifestJson: { ...pluginManifest, agents: [] } }).where(eq(plugins.id, pluginId));
      } else {
        const otherId = randomUUID();
        await db.insert(plugins).values({ id: otherId, pluginKey: "paperclip.other-owner", packageName: "other",
          version: "0.1.0", apiVersion: 1, categories: [], manifestJson: { ...pluginManifest, id: "paperclip.other-owner" }, status: "ready", installOrder: 2 });
        await db.update(agents).set({ metadata: { ...created.agent!.metadata,
          paperclipManagedResource: { pluginId: otherId, pluginKey: pluginManifest.id, resourceKind: "agent", resourceKey: "wiki-maintainer" },
        } }).where(eq(agents.id, created.agentId!));
      }
      const [before] = await db.select().from(agents).where(eq(agents.id, created.agentId!));
      await expect(services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" })).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(pluginEntities)).toHaveLength(0);
      expect(await db.select().from(pluginManagedResources)).toHaveLength(0);
      const [after] = await db.select().from(agents).where(eq(agents.id, created.agentId!));
      expect(after.metadata).toEqual(before.metadata);
    },
  );

  it("respects board approval policy for new managed agents", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ requireApproval: true });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent?.status).toBe("pending_approval");
    expect(created.approvalId).toBeTruthy();

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, created.approvalId!));
    expect(approval).toMatchObject({
      type: "hire_agent",
      status: "pending",
    });
    expect(approval?.payload).toMatchObject({
      agentId: created.agentId,
      sourcePluginKey: "paperclip.managed-agents-test",
      managedResourceKey: "wiki-maintainer",
    });
  });
});
