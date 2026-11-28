import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { EnvironmentCapacityExhaustedError, environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { runAdmissionCommand, selectOverflowEnvironmentId, type EnvironmentOverflowDeps } from "./environment-overflow.js";
import { selectHeartbeatEnvironment, type HeartbeatEnvironmentSelectionInput } from "./environment-selection.js";

const env = (id: string, capacity?: Record<string, unknown>, extra: Partial<Environment> = {}) =>
  ({ id, status: "active", driver: id === "local" ? "local" : "ssh", config: capacity ? { capacity } : {}, ...extra }) as Environment;

function deps(environmentsList: Environment[], leases: Record<string, number> = {}, overrides: Partial<EnvironmentOverflowDeps> = {}): EnvironmentOverflowDeps {
  return {
    getEnvironment: async (id) => environmentsList.find((e) => e.id === id) ?? null,
    findAffinityEnvironmentId: async () => null,
    countActiveLeases: async (id) => leases[id] ?? 0,
    admit: async () => true,
    ...overrides,
  };
}

const select = (d: EnvironmentOverflowDeps, fallbacks = ["nomad"]) =>
  selectOverflowEnvironmentId({ primaryEnvironmentId: "local", fallbackEnvironmentIds: fallbacks }, d);

describe("environment overflow selection", () => {
  it("keeps the primary while it has capacity", async () => {
    expect(await select(deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")]))).toBe("local");
  });

  it("overflows to the next admitted candidate when the primary is full", async () => {
    expect(await select(deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")], { local: 1 }))).toBe("nomad");
  });

  it("admits no candidate when the primary is full and every fallback refuses", async () => {
    const admit = vi.fn(async () => false);
    const d = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad", { admissionCommand: ["probe"] })], { local: 1 }, { admit });
    expect(await select(d)).toBeNull();
    expect(admit).toHaveBeenCalledWith(["probe"]);
  });

  it("skips archived, non-host and missing candidates", async () => {
    const d = deps([env("local", { maxConcurrentRuns: 1 }), env("other", undefined, { driver: "sandbox" }), env("off", undefined, { status: "archived" as Environment["status"] }), env("nomad")], { local: 1 });
    expect(await select(d, ["missing", "other", "off", "nomad"])).toBe("nomad");
  });

  it("prefers the candidate that hosted the session while it still admits", async () => {
    const pinned = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")], {}, { findAffinityEnvironmentId: async () => "nomad" });
    expect(await select(pinned)).toBe("nomad");
    const departed = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad", { admissionCommand: ["probe"] })], {},
      { findAffinityEnvironmentId: async () => "nomad", admit: async () => false });
    expect(await select(departed)).toBe("local");
  });

  it("does not query anything without fallbacks", async () => {
    const getEnvironment = vi.fn();
    expect(await select(deps([], {}, { getEnvironment }), [])).toBe("local");
    expect(getEnvironment).not.toHaveBeenCalled();
  });

  it("admits only a zero exit within the timeout", async () => {
    expect(await runAdmissionCommand(["sh", "-c", "exit 0"])).toBe(true);
    expect(await runAdmissionCommand(["sh", "-c", "exit 3"])).toBe(false);
    expect(await runAdmissionCommand(["/nonexistent/paperclip-probe"])).toBe(false);
    expect(await runAdmissionCommand(["sh", "-c", "sleep 5"], 100)).toBe(false);
  });

  it("kills the probe's whole process group on timeout", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "admission-probe-")), "pid");
    expect(await runAdmissionCommand(["sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`], 300)).toBe(false);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("agent environment overflow boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-environment-overflow-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "environment-overflow");
    await mkdir(resolvePaperclipInstanceRoot(), { recursive: true });
    database = await startEmbeddedPostgresTestDatabase("heartbeat-environment-overflow-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function overflowFixture() {
    const [company] = await db.insert(companies).values({ name: "Environment overflow", issuePrefix: "OVF" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Overflow agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Overflow run", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const local = await environmentService(db).ensureLocalEnvironment(company.id);
    await db.update(environments).set({ config: { capacity: { maxConcurrentRuns: 1 } } }).where(eq(environments.id, local.id));
    const [remote] = await db.insert(environments).values({
      name: `Overflow host ${randomUUID()}`,
      driver: "ssh",
      status: "active",
      config: { host: "overflow.invalid", port: 22, username: "agent", remoteWorkspacePath: "/srv/work" },
    }).returning();
    agent.defaultEnvironmentId = local.id;
    agent.runtimeConfig = { fallbackEnvironmentIds: [remote.id] };
    const input: HeartbeatEnvironmentSelectionInput = {
      run,
      agent,
      task: {
        issueRef: issue,
        issueContext: issue,
        issueId: issue.id,
        executionProjectId: project.id,
        workspaceProjectContext: { hasWorkspace: false },
        boundSourceWorkspace: null,
        hasSelectedWorkspaceSource: false,
        taskWorkspaceIntent: null,
        responsibleUserId: null,
        context: { issueId: issue.id },
      },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        requestedExecutionWorkspaceMode: "shared_workspace",
        isolatedWorkspacesEnabled: true,
        projectExecutionWorkspacePolicy: null,
        issueExecutionWorkspaceSettings: null,
      },
      config: { config: {}, sourceWorkspaceConfig: {}, issueAssigneeOverrides: null },
      services: {
        environmentsSvc: environmentService(db),
        executionWorkspacesSvc: executionWorkspaceService(db),
        instanceSettings: instanceSettingsService(db),
        findSharedWorkspaceHolder: vi.fn(async () => null),
        findExecutionWorkspaceHolder: vi.fn(async () => null),
      },
    };
    const lease = (environmentId: string, values: Partial<typeof environmentLeases.$inferInsert> = {}) =>
      db.insert(environmentLeases).values({ companyId: company.id, environmentId, status: "active", ...values });
    return { input, issue, local, remote, lease };
  }

  it("overflows only while the agent default is full", async () => {
    const { input, local, remote, lease } = await overflowFixture();
    expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(local.id);
    await lease(local.id);
    expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
  });

  it("does not overflow placements that do not come from the agent default", async () => {
    const { input, local, lease } = await overflowFixture();
    await lease(local.id);
    input.agent.defaultEnvironmentId = null;
    expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(local.id);
  });

  it("defers while every candidate is full and admits once a slot frees", async () => {
    const { input, local, remote, lease } = await overflowFixture();
    await db.update(environments).set({ config: { ...remote.config, capacity: { maxConcurrentRuns: 1 } } }).where(eq(environments.id, remote.id));
    await lease(local.id);
    const [held] = await lease(remote.id).returning();
    await expect(selectHeartbeatEnvironment(db, input)).rejects.toMatchObject({ name: "WorkspaceBusyDeferral", capacityEnvironmentId: local.id });
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, held!.id));
    expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
  });

  it("lets only one concurrent run lease take the last slot", async () => {
    const { input, local } = await overflowFixture();
    const take = () => environmentService(db).acquireLease({ companyId: input.agent.companyId, environmentId: local.id, maxConcurrentRuns: 1 });
    const results = await Promise.allSettled([take(), take()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(EnvironmentCapacityExhaustedError) });
  });

  it("returns an issue session to the host that last ran it", async () => {
    const { input, issue, remote, lease } = await overflowFixture();
    await lease(remote.id, { status: "released", issueId: issue.id, metadata: { agentId: input.agent.id } });
    expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
  });
});
