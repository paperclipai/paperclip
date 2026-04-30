import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  executionWorkspaces,
  projects,
  projectWorkspaces,
  issues,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workspaceDriftGuard } from "../services/routine-checks/checks/workspace-drift-guard.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const fsStub = {} as unknown as typeof import("node:fs/promises");

interface SeedRefs {
  companyId: string;
  agentId: string;
  projectId: string;
}

describeDb("workspace-drift-guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pc-drift-guard-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE heartbeat_run_events, heartbeat_runs, issues, project_workspaces, projects, execution_workspaces, agents, companies RESTART IDENTITY CASCADE`);
  });

  async function makeCompany(name: string): Promise<string> {
    const prefixBase = name.replace(/\W/g, "").slice(0, 5).toUpperCase() || "X";
    // ensure issue_prefix uniqueness across multiple companies in same test
    const prefix = `${prefixBase}${Math.floor(Math.random() * 10000)}`.slice(0, 8);
    const r = await db.insert(companies).values({
      name,
      issuePrefix: prefix,
    }).returning();
    return r[0]!.id;
  }

  async function makeDefaultAgent(companyId: string): Promise<string> {
    const r = await db.insert(agents).values({
      companyId,
      name: `default-agent-${companyId.slice(0, 8)}`,
      role: "general",
      adapterType: "process",
      adapterConfig: {},
    }).returning();
    return r[0]!.id;
  }

  async function makeDefaultProject(companyId: string): Promise<string> {
    const r = await db.insert(projects).values({
      companyId,
      name: "default-project",
    }).returning();
    return r[0]!.id;
  }

  async function seedHappyAndCasa(): Promise<{ happy: SeedRefs; casa: SeedRefs }> {
    const happyId = await makeCompany("HAPPYGANG");
    const casaId = await makeCompany("Casa Marco");
    const happyAgent = await makeDefaultAgent(happyId);
    const casaAgent = await makeDefaultAgent(casaId);
    const happyProject = await makeDefaultProject(happyId);
    const casaProject = await makeDefaultProject(casaId);
    return {
      happy: { companyId: happyId, agentId: happyAgent, projectId: happyProject },
      casa: { companyId: casaId, agentId: casaAgent, projectId: casaProject },
    };
  }

  it("returns ok with zero drift when only matching companies have no drift rows", async () => {
    await seedHappyAndCasa();
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
    expect(r.payload).toEqual({
      companies: expect.arrayContaining([
        expect.objectContaining({ name: "HAPPYGANG", local_agent_cwd_outside: 0 }),
        expect.objectContaining({ name: "Casa Marco", local_agent_cwd_outside: 0 }),
      ]),
      examples: [],
    });
  });

  it("ignores other companies", async () => {
    const otherId = await makeCompany("Other Co");
    await db.insert(agents).values({
      companyId: otherId,
      name: "x",
      role: "general",
      adapterType: "claude_local",
      adapterConfig: { cwd: "/tmp/somewhere" },
    });
    await seedHappyAndCasa();
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
  });

  it("counts agents with cwd outside prefix (HAPPYGANG)", async () => {
    const { happy } = await seedHappyAndCasa();
    await db.insert(agents).values([
      { companyId: happy.companyId, name: "ok-agent", role: "general", adapterType: "claude_local", adapterConfig: { cwd: "/Users/marco/.openclaw/workspace/projects/x" } },
      { companyId: happy.companyId, name: "drift", role: "general", adapterType: "claude_local", adapterConfig: { cwd: "/tmp/somewhere" } },
      { companyId: happy.companyId, name: "drift2", role: "general", adapterType: "codex_local", adapterConfig: { cwd: "/elsewhere" } },
      { companyId: happy.companyId, name: "non-local", role: "general", adapterType: "process", adapterConfig: { cwd: "/tmp/skipme" } }, // not in LOCAL_ADAPTERS
    ]);
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("warn");
    expect(r.findings).toBe(2);
    const happyRow = (r.payload as { companies: CompanyRowShape[] }).companies.find((c) => c.name === "HAPPYGANG");
    expect(happyRow?.local_agent_cwd_outside).toBe(2);
  });

  it("counts active execution_workspaces outside prefix and surfaces examples", async () => {
    const { happy } = await seedHappyAndCasa();
    await db.insert(executionWorkspaces).values([
      { companyId: happy.companyId, projectId: happy.projectId, mode: "isolated", strategyType: "branch", name: "ews-drift-1", status: "active", providerRef: "/tmp/ews1" },
      { companyId: happy.companyId, projectId: happy.projectId, mode: "isolated", strategyType: "branch", name: "ews-drift-2", status: "active", cwd: "/Users/marco/elsewhere/x" },
      { companyId: happy.companyId, projectId: happy.projectId, mode: "isolated", strategyType: "branch", name: "ews-ok",      status: "active", cwd: "/Users/marco/.openclaw/workspace/ok" },
      { companyId: happy.companyId, projectId: happy.projectId, mode: "isolated", strategyType: "branch", name: "ews-archived", status: "archived", cwd: "/tmp/skip" }, // status != active
    ]);
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.findings).toBe(2);
    const payload = r.payload as { companies: CompanyRowShape[]; examples: string[] };
    const happyRow = payload.companies.find((c) => c.name === "HAPPYGANG");
    expect(happyRow?.active_exec_ws_outside).toBe(2);
    expect(payload.examples.length).toBeGreaterThan(0);
    expect(payload.examples.some((p) => p.startsWith("HAPPYGANG:"))).toBe(true);
  });

  it("counts open issues without project_workspace (with project_id set)", async () => {
    const { happy } = await seedHappyAndCasa();
    const projectA = await db.insert(projects).values({ companyId: happy.companyId, name: "A" }).returning();
    const projectB = await db.insert(projects).values({ companyId: happy.companyId, name: "B" }).returning();
    await db.insert(projectWorkspaces).values({
      companyId: happy.companyId,
      projectId: projectA[0]!.id,
      name: "ws-A",
      sourceType: "git",
    });
    // issue on projectA -> has workspace -> NOT counted
    await db.insert(issues).values({ companyId: happy.companyId, projectId: projectA[0]!.id, title: "ok-issue", status: "todo", issueNumber: 1 });
    // issue on projectB -> NO workspace -> COUNTED
    await db.insert(issues).values({ companyId: happy.companyId, projectId: projectB[0]!.id, title: "drift", status: "todo", issueNumber: 2 });
    // issue on projectB but status=done -> NOT counted
    await db.insert(issues).values({ companyId: happy.companyId, projectId: projectB[0]!.id, title: "done", status: "done", issueNumber: 3 });
    // issue with NULL project_id -> NOT counted (spec says project_id required)
    await db.insert(issues).values({ companyId: happy.companyId, projectId: null, title: "no-project", status: "todo", issueNumber: 4 });
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    const payload = r.payload as { companies: CompanyRowShape[] };
    const happyRow = payload.companies.find((c) => c.name === "HAPPYGANG");
    expect(happyRow?.open_issues_without_project_workspace).toBe(1);
  });

  it("counts heartbeat_run_events within last 24h with outside cwd", async () => {
    const { happy } = await seedHappyAndCasa();
    const run = await db.insert(heartbeatRuns).values({
      companyId: happy.companyId,
      agentId: happy.agentId,
    }).returning();
    await db.insert(heartbeatRunEvents).values([
      {
        companyId: happy.companyId,
        runId: run[0]!.id,
        agentId: happy.agentId,
        seq: 1,
        eventType: "tick",
        payload: { context: { paperclipWorkspace: { cwd: "/tmp/elsewhere" } } },
      },
      {
        companyId: happy.companyId,
        runId: run[0]!.id,
        agentId: happy.agentId,
        seq: 2,
        eventType: "tick",
        payload: { context: { paperclipWorkspace: { cwd: "/Users/marco/.openclaw/workspace/x" } } },
      },
    ]);
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    const payload = r.payload as { companies: CompanyRowShape[] };
    const happyRow = payload.companies.find((c) => c.name === "HAPPYGANG");
    expect(happyRow?.run_event_context_cwd_outside_24h).toBe(1);
  });

  it("aggregates summary string correctly", async () => {
    const { happy } = await seedHappyAndCasa();
    await db.insert(agents).values({
      companyId: happy.companyId, name: "x", role: "general",
      adapterType: "claude_local", adapterConfig: { cwd: "/elsewhere" },
    });
    const r = await workspaceDriftGuard.run({ db, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.summary).toContain("HAPPYGANG: 1/0/0/0");
    expect(r.summary).toContain("Casa Marco: 0/0/0/0");
  });
});

interface CompanyRowShape {
  name: string;
  local_agent_cwd_outside: number;
  active_exec_ws_outside: number;
  open_issues_without_project_workspace: number;
  run_event_context_cwd_outside_24h: number;
}
