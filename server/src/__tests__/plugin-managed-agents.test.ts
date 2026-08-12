import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  createDb,
  pluginEntities,
  pluginCompanySettings,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

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
        runtimeConfig: { modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "small" } } } },
        permissions: { canCreateAgents: false },
        budgetMonthlyCents: 1234,
      },
    ],
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(pluginCompanySettings);
    await db.delete(approvals);
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
        adapterType: "codex_local",
        adapterConfig: {},
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
    expect(created.agent?.adapterType).toBe("codex_local");
  });

  it("materializes declared managed agent instructions with local folder paths", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-home-"));
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
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(wikiRoot, { recursive: true, force: true });
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

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.data).toMatchObject({ agentId });
  });

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
