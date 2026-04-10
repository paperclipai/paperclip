import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CURRENT_SHARED_DEFAULT_AGENT_INSTRUCTIONS_BASELINE,
  LEGACY_GENERIC_DEFAULT_AGENT_INSTRUCTIONS_BASELINE,
  agentRoleMigrationService,
} from "../services/agent-role-migration.ts";
import { agentInstructionsService } from "../services/agent-instructions.ts";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent role migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentRoleMigrationService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-migration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("backfills legacy operations roles and reseeds only untouched managed bundles", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-role-migration-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-role-migration-test";

    const companyId = "11111111-1111-4111-8111-111111111111";
    const defaultAgentId = "22222222-2222-4222-8222-222222222222";
    const customAgentId = "33333333-3333-4333-8333-333333333333";
    const approvalId = "44444444-4444-4444-8444-444444444444";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: defaultAgentId,
        companyId,
        name: "Operations Agent",
        role: "operations",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: customAgentId,
        companyId,
        name: "Custom Operations Agent",
        role: "coo",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const instructions = agentInstructionsService();
    const defaultAgent = (await db.select().from(agents).where(eq(agents.id, defaultAgentId)).then((rows) => rows[0]))!;
    const customAgent = (await db.select().from(agents).where(eq(agents.id, customAgentId)).then((rows) => rows[0]))!;

    const defaultMaterialized = await instructions.materializeManagedBundle(
      defaultAgent,
      { "AGENTS.md": LEGACY_GENERIC_DEFAULT_AGENT_INSTRUCTIONS_BASELINE },
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    await db.update(agents).set({ adapterConfig: defaultMaterialized.adapterConfig }).where(eq(agents.id, defaultAgentId));

    const customMaterialized = await instructions.materializeManagedBundle(
      customAgent,
      { "AGENTS.md": "Custom operations instructions.\n" },
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    await db.update(agents).set({ adapterConfig: customMaterialized.adapterConfig }).where(eq(agents.id, customAgentId));

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: {
        name: "Legacy Operations Hire",
        role: "operations",
        adapterType: "process",
        adapterConfig: {},
      },
    });

    const svc = agentRoleMigrationService(db);
    const report = await svc.migrateOperationsToCoo({ apply: true });

    expect(report.agentRolesUpdated).toBe(1);
    expect(report.approvalPayloadsUpdated).toBe(1);
    expect(report.managedBundlesReseeded).toBe(1);
    expect(report.managedBundlesPreserved).toBeGreaterThanOrEqual(1);

    const migratedDefaultAgent = await db.select().from(agents).where(eq(agents.id, defaultAgentId)).then((rows) => rows[0]);
    const migratedCustomAgent = await db.select().from(agents).where(eq(agents.id, customAgentId)).then((rows) => rows[0]);
    const migratedApproval = await db.select().from(approvals).where(eq(approvals.id, approvalId)).then((rows) => rows[0]);

    expect(migratedDefaultAgent?.role).toBe("coo");
    expect(migratedCustomAgent?.role).toBe("coo");
    expect((migratedApproval?.payload as Record<string, unknown>).role).toBe("coo");

    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const defaultBundleFiles = await instructions.exportFiles(migratedDefaultAgent!);
    const customBundleFiles = await instructions.exportFiles(migratedCustomAgent!);

    expect(defaultBundleFiles.files).toEqual(cooBundle);
    expect(customBundleFiles.files["AGENTS.md"]).toBe("Custom operations instructions.\n");
  });

  it("recognizes the shared default workflow baseline as safe to reseed", () => {
    expect(CURRENT_SHARED_DEFAULT_AGENT_INSTRUCTIONS_BASELINE).toContain("[RECOVERED BY REISSUE]");
  });
});
