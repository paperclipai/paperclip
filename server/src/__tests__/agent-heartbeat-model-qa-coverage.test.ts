import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  QA_RELEASE_DEFAULT_NAME,
  QA_RELEASE_DEFAULT_TITLE,
  SECURITY_DEFAULT_NAME,
  SECURITY_DEFAULT_TITLE,
  agentHeartbeatModelService,
} from "../services/agent-heartbeat-model.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres QA coverage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentHeartbeatModelService QA coverage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-heartbeat-model-qa-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

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

  it("backfills QA and Release Engineer for tech-team companies missing QA", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-heartbeat-model-qa-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-heartbeat-model-qa-test";

    const companyId = "11111111-1111-4111-8111-111111111111";
    const ceoId = "22222222-2222-4222-8222-222222222222";
    const engineerId = "33333333-3333-4333-8333-333333333333";

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerId,
        companyId,
        name: "Engineer",
        role: "engineer",
        reportsTo: ceoId,
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/legacy",
          promptTemplate: "legacy prompt",
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const svc = agentHeartbeatModelService(db);
    const report = await svc.backfillMissingQaReleaseEngineers({ apply: true });

    expect(report.scannedCompanies).toBe(1);
    expect(report.companiesWithTechTeam).toBe(1);
    expect(report.companiesWithQa).toBe(0);
    expect(report.companiesMissingQa).toBe(1);
    expect(report.createdAgents).toBe(1);
    expect(report.createdCompanyIds).toEqual([companyId]);

    const qaAgent = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.find((row) => row.role === "qa") ?? null);

    expect(qaAgent).not.toBeNull();
    expect(qaAgent?.name).toBe(QA_RELEASE_DEFAULT_NAME);
    expect(qaAgent?.title).toBe(QA_RELEASE_DEFAULT_TITLE);
    expect(qaAgent?.reportsTo).toBe(ceoId);
    expect(qaAgent?.adapterType).toBe("codex_local");
    expect((qaAgent?.adapterConfig as Record<string, unknown>).model).toBe("gpt-5.4");
    expect((qaAgent?.adapterConfig as Record<string, unknown>).promptTemplate).toBeUndefined();
    expect((qaAgent?.adapterConfig as Record<string, unknown>).instructionsBundleMode).toBe("managed");

    const instructions = agentInstructionsService();
    const files = await instructions.exportFiles(qaAgent!);
    const expectedQaBundle = await loadDefaultAgentInstructionsBundle("qa");
    const { ["AGENTS.md"]: expectedAgentsMd = "", ...expectedOtherFiles } = expectedQaBundle;
    const { ["AGENTS.md"]: actualAgentsMd = "", ...actualOtherFiles } = files.files;
    expect(actualOtherFiles).toEqual(expectedOtherFiles);
    expect(actualAgentsMd).toContain(expectedAgentsMd.trim());
    expect(actualAgentsMd).toContain("paperclip:qa-baseline:start");
    expect(actualAgentsMd).toContain("[QA PASS]");
    expect(actualAgentsMd).toContain("[RELEASE CONFIRMED]");
    expect(actualAgentsMd).toContain("[CQ:pass|warn|fail|na]");
    expect(actualAgentsMd).toContain("[DOC:pass|warn|fail|na]");
  });

  it("repairs drifted managed QA instructions without deleting custom persona content", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-heartbeat-model-qa-sync-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-heartbeat-model-qa-sync-test";

    const companyId = "66666666-6666-4666-8666-666666666666";
    const qaId = "77777777-7777-4777-8777-777777777777";

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: qaId,
      companyId,
      name: "Benchmark Archivist",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const instructions = agentInstructionsService();
    const materialized = await instructions.materializeManagedBundle(
      {
        id: qaId,
        companyId,
        name: "Benchmark Archivist",
        role: "qa",
        adapterConfig: {},
      },
      {
        "AGENTS.md": "# Benchmark Archivist\nArchive benchmark runs and replay traces.\n",
      },
      { entryFile: "AGENTS.md", replaceExisting: true },
    );

    await db
      .update(agents)
      .set({ adapterConfig: materialized.adapterConfig, updatedAt: new Date() })
      .where(eq(agents.id, qaId));

    await fs.writeFile(
      path.join(materialized.bundle.rootPath ?? "", "AGENTS.md"),
      "# Benchmark Archivist\nArchive benchmark runs and replay traces.\n",
      "utf8",
    );

    const svc = agentHeartbeatModelService(db);
    const report = await svc.syncQaReleaseEngineerInstructions({ apply: true });

    expect(report.scannedQaAgents).toBe(1);
    expect(report.updatedAgents).toBe(1);
    expect(report.updatedAgentIds).toEqual([qaId]);

    const qaAgent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, qaId))
      .then((rows) => rows[0] ?? null);

    const files = await instructions.exportFiles(qaAgent!);
    const agentsMd = files.files["AGENTS.md"] ?? "";
    expect(agentsMd).toContain("# Benchmark Archivist");
    expect(agentsMd).toContain("Archive benchmark runs and replay traces.");
    expect(agentsMd).toContain("paperclip:qa-baseline:start");
    expect(agentsMd).toContain("[QA PASS]");
    expect(agentsMd).toContain("[RELEASE CONFIRMED]");
    expect(agentsMd).toContain("[CQ:pass|warn|fail|na]");
    expect(agentsMd).toContain("[DOC:pass|warn|fail|na]");
    expect(agentsMd).toContain("[TYPECHECK:pass|fail]");
    expect(agentsMd).toContain("[SMOKE:pass|fail|na]");
  });

  it("skips companies that do not have a tech team", async () => {
    const companyId = "44444444-4444-4444-8444-444444444444";

    await db.insert(companies).values({
      id: companyId,
      name: "No Tech Team Co",
      issuePrefix: "NTC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: "55555555-5555-4555-8555-555555555555",
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = agentHeartbeatModelService(db);
    const report = await svc.backfillMissingQaReleaseEngineers({ apply: true });

    expect(report.scannedCompanies).toBe(1);
    expect(report.companiesWithTechTeam).toBe(0);
    expect(report.companiesSkippedNoTechTeam).toBe(1);
    expect(report.createdAgents).toBe(0);

    const qaAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => row.role === "qa"));
    expect(qaAgents).toHaveLength(0);
  });

  it("provisions a Security Engineer for tech-team companies missing security coverage", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-heartbeat-model-security-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-heartbeat-model-security-test";

    const companyId = "88888888-8888-4888-8888-888888888888";
    const ctoId = "99999999-9999-4999-8999-999999999999";

    await db.insert(companies).values({
      id: companyId,
      name: "Security Coverage Co",
      issuePrefix: "SEC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ctoId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.4",
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/legacy-security",
        promptTemplate: "legacy prompt",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const svc = agentHeartbeatModelService(db);
    const result = await svc.ensureCompanyHasSecurityEngineer(companyId, { apply: true });

    expect(result).toMatchObject({
      apply: true,
      companyId,
      created: true,
      reason: "security_created",
    });

    const securityAgent = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.find((row) => row.role === "security") ?? null);

    expect(securityAgent).not.toBeNull();
    expect(securityAgent?.name).toBe(SECURITY_DEFAULT_NAME);
    expect(securityAgent?.title).toBe(SECURITY_DEFAULT_TITLE);
    expect(securityAgent?.reportsTo).toBe(ctoId);
    expect(securityAgent?.adapterType).toBe("codex_local");
    expect((securityAgent?.adapterConfig as Record<string, unknown>).model).toBe("gpt-5.4");
    expect((securityAgent?.adapterConfig as Record<string, unknown>).promptTemplate).toBeUndefined();
    expect((securityAgent?.adapterConfig as Record<string, unknown>).instructionsBundleMode).toBe("managed");

    const instructions = agentInstructionsService();
    const files = await instructions.exportFiles(securityAgent!);
    const expectedSecurityBundle = await loadDefaultAgentInstructionsBundle("security");
    const { ["AGENTS.md"]: expectedAgentsMd = "", ...expectedOtherFiles } = expectedSecurityBundle;
    const { ["AGENTS.md"]: actualAgentsMd = "", ...actualOtherFiles } = files.files;
    expect(actualOtherFiles).toEqual(expectedOtherFiles);
    expect(actualAgentsMd).toContain(expectedAgentsMd.trim());
    expect(actualAgentsMd).toContain("Security Engineer");
    expect(actualAgentsMd).toContain("threat-review");
    expect(actualAgentsMd).toContain("[SECURITY FAIL]");
  });

  it("does not provision duplicate Security Engineers when existing security coverage is unavailable", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-heartbeat-model-security-paused-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-heartbeat-model-security-paused-test";

    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await db.insert(companies).values({
      id: companyId,
      name: "Paused Security Coverage Co",
      issuePrefix: "PSC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        name: "Paused Security Engineer",
        role: "security",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const svc = agentHeartbeatModelService(db);
    const result = await svc.ensureCompanyHasSecurityEngineer(companyId, { apply: true });

    expect(result).toMatchObject({
      apply: true,
      companyId,
      created: false,
      reason: "already_has_security",
      createdAgentId: null,
    });

    const securityAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => row.role === "security"));
    expect(securityAgents).toHaveLength(1);
    expect(securityAgents[0]?.status).toBe("paused");
  });

  it("does not provision duplicate QA reviewers when existing QA coverage is unavailable", async () => {
    const companyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await db.insert(companies).values({
      id: companyId,
      name: "Errored QA Coverage Co",
      issuePrefix: "EQC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId,
        name: "Errored QA and Release Engineer",
        role: "qa",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const svc = agentHeartbeatModelService(db);
    const result = await svc.ensureCompanyHasQaReleaseEngineer(companyId, { apply: true });

    expect(result).toMatchObject({
      apply: true,
      companyId,
      created: false,
      reason: "already_has_qa",
      createdAgentId: null,
    });

    const qaAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => row.role === "qa"));
    expect(qaAgents).toHaveLength(1);
    expect(qaAgents[0]?.status).toBe("error");
  });
});
