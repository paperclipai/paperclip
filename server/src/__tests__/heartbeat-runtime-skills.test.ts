import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "runtime_skill_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat runtime skill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat runtime skill version pins", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;
  const capturedRuns: Array<{
    agentId: string;
    skills: PaperclipSkillEntry[];
    mcpServers: AdapterRuntimeMcpServer[];
    config: Record<string, unknown>;
    serializedRuntimeInput: string;
  }> = [];
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-runtime-skills-");
    db = createDb(tempDb.connectionString);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-skills-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    // The server normalizes PAPERCLIP_API_URL into its own env at boot
    // (server/src/index.ts); heartbeat gateway delivery requires it, so pin
    // a deterministic value for tests that never boot the full server.
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        const serializedRuntimeInput = JSON.stringify({
          config: ctx.config,
          context: ctx.context,
          runtimeMcp: ctx.runtimeMcp,
        });
        await ctx.onLog("stdout", `${serializedRuntimeInput}\n`);
        capturedRuns.push({
          agentId: ctx.agent.id,
          skills: (ctx.config.paperclipRuntimeSkills ?? []) as PaperclipSkillEntry[],
          mcpServers: ctx.runtimeMcp?.getServers() ?? [],
          config: ctx.config,
          serializedRuntimeInput,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          label: "Captured runtime skills",
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    capturedRuns.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skill_versions",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  it("materializes different pinned skill versions for different agents at runtime", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const skillKey = `company/${companyId}/runtime-coach`;
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-versioned-runtime-skill-"));
    cleanupDirs.add(skillDir);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Runtime Coach\n\nVersion one.\n", "utf8");
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "runtime-coach",
      name: "Runtime Coach",
      description: null,
      markdown: "# Runtime Coach\n\nVersion one.\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const skills = companySkillService(db);
    const versionOne = await skills.createVersion(
      companyId,
      skillId,
      { label: "v1" },
      { type: "user", userId: "board" },
    );
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Runtime Coach\n\nVersion two.\n", "utf8");
    await db
      .update(companySkills)
      .set({ markdown: "# Runtime Coach\n\nVersion two.\n", updatedAt: new Date() })
      .where(eq(companySkills.id, skillId));
    const versionTwo = await skills.createVersion(
      companyId,
      skillId,
      { label: "v2" },
      { type: "user", userId: "board" },
    );

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "Pinned V1",
        role: "engineer",
        status: "idle",
        adapterType: TEST_ADAPTER_TYPE,
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [{ key: skillKey, versionId: versionOne.id }],
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Pinned V2",
        role: "engineer",
        status: "idle",
        adapterType: TEST_ADAPTER_TYPE,
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [{ key: skillKey, versionId: versionTwo.id }],
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const heartbeat = heartbeatService(db);
    const firstRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "manual");
    expect(firstRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, firstRun!.id))?.status).toBe("succeeded");

    const secondRun = await heartbeat.invoke(secondAgentId, "on_demand", {}, "manual");
    expect(secondRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, secondRun!.id))?.status).toBe("succeeded");

    const firstSkill = capturedRuns.find((run) => run.agentId === firstAgentId)?.skills
      .find((entry) => entry.key === skillKey);
    const secondSkill = capturedRuns.find((run) => run.agentId === secondAgentId)?.skills
      .find((entry) => entry.key === skillKey);

    expect(firstSkill).toMatchObject({
      key: skillKey,
      versionId: versionOne.id,
      currentVersionId: versionTwo.id,
      sourceStatus: "available",
    });
    expect(secondSkill).toMatchObject({
      key: skillKey,
      versionId: versionTwo.id,
      currentVersionId: versionTwo.id,
      sourceStatus: "available",
    });
    await expect(fs.readFile(path.join(firstSkill!.source, "SKILL.md"), "utf8"))
      .resolves.toContain("Version one.");
    await expect(fs.readFile(path.join(secondSkill!.source, "SKILL.md"), "utf8"))
      .resolves.toContain("Version two.");

    const firstSkillFile = path.join(firstSkill!.source, "SKILL.md");
    const oldMtime = new Date("2024-01-01T00:00:00.000Z");
    await fs.utimes(firstSkillFile, oldMtime, oldMtime);

    const repeatRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "manual");
    expect(repeatRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, repeatRun!.id))?.status).toBe("succeeded");
    const repeatedSkill = capturedRuns
      .filter((run) => run.agentId === firstAgentId)
      .at(-1)
      ?.skills.find((entry) => entry.key === skillKey);
    expect(repeatedSkill).toMatchObject({
      source: firstSkill!.source,
      versionId: versionOne.id,
      sourceStatus: "available",
    });
    expect((await fs.stat(firstSkillFile)).mtime.toISOString()).toBe(oldMtime.toISOString());
  });

  it("delivers installed connections without exposing gateway bearers in adapter config or logs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Runtime MCP Delivery",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime MCP Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey: `runtime-${randomUUID().slice(0, 8)}`,
      name: "Runtime MCP",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [installed, uninstalled] = await db.insert(toolConnections).values([
      {
        companyId,
        applicationId: application!.id,
        name: "Installed Runtime MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://installed.example.test/mcp" },
      },
      {
        companyId,
        applicationId: application!.id,
        name: "Uninstalled Runtime MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://uninstalled.example.test/mcp" },
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId,
      profileKey: `app:${installed!.id}`,
      name: installed!.name,
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: installed!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agentId,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId,
      connectionId: installed!.id,
      targetType: "agent",
      targetId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const captured = capturedRuns.find((entry) => entry.agentId === agentId);
    expect(captured?.mcpServers).toHaveLength(1);
    expect(captured?.mcpServers[0]).toMatchObject({
      connectionId: installed!.id,
      name: installed!.name,
      token: expect.stringMatching(/^pcgw_/),
      url: expect.stringContaining("/api/tool-gateway/gateways/"),
    });
    expect(captured?.mcpServers.some((server) => server.connectionId === uninstalled!.id)).toBe(false);
    const bearer = captured?.mcpServers[0]?.token;
    expect(bearer).toMatch(/^pcgw_/);
    if (!bearer) throw new Error("Expected runtime MCP bearer");
    expect(captured?.config).not.toHaveProperty("paperclipRuntimeMcpServers");
    expect(JSON.stringify(captured?.config)).not.toContain(bearer);
    expect(captured?.serializedRuntimeInput).not.toContain(bearer);
    const log = await heartbeat.readLog(run!.id);
    expect(log.content).not.toContain(bearer);
    expect(log.content).not.toContain("pcgw_");
  });
});
