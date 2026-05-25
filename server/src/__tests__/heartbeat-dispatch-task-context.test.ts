/**
 * Dispatcher task-context injection (foundational bug fix).
 *
 * Verifies that `heartbeat.executeRun` layers `issueContext.id`,
 * `issueContext.title`, and `issueContext.description` onto the
 * `config` object passed to `adapter.execute({...})` as
 * `taskId`/`taskTitle`/`taskBody`. The hermes adapter reads those keys
 * to render the `{{#taskId}}...{{/taskId}}` "Assigned Task" mustache
 * block in its DEFAULT_PROMPT_TEMPLATE; without them, workers receive
 * only the generic heartbeat-wake template.
 *
 * Strategy: register a custom test adapter (`ctx-capture`) that dumps
 * the relevant `ctx.config` keys to disk; drive the dispatcher with a
 * real issue + assignee + `{ issueId }` context snapshot; then read
 * the dumped file and assert on shape.
 *
 * Covers four cases:
 *   1. Non-guild agent with an assigned issue: taskId/title/body all set.
 *   2. Guild agent with an assigned issue: taskId/title/body still set
 *      (the guildSandboxDir branch layers them too).
 *   3. No issueContext (issueless heartbeat wake): taskId is NOT set.
 *   4. Issue with null description: taskBody is empty string (not "null").
 *
 * The escalation retry path (lines 8407-8431 of heartbeat.ts) reuses
 * `runtimeConfigForAdapter` for `config:`, so it is covered transitively.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  skills,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import type { ServerAdapterModule } from "../adapters/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dispatcher task-context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CAPTURE_ADAPTER_TYPE = "ctx-capture-test";

/** Build a one-shot capture adapter that writes a JSON file containing
 * the dispatcher-provided `ctx.config` fields we care about. Each test
 * gets its own `dumpPath` so concurrent runs don't collide. */
function buildCaptureAdapter(dumpPath: string): ServerAdapterModule {
  return {
    type: CAPTURE_ADAPTER_TYPE,
    execute: async (ctx) => {
      const cfg = ctx.config as Record<string, unknown>;
      const snapshot = {
        hasTaskId: "taskId" in cfg,
        taskId: cfg.taskId ?? null,
        taskTitle: cfg.taskTitle ?? null,
        taskBody: cfg.taskBody ?? null,
      };
      await fs.writeFile(dumpPath, JSON.stringify(snapshot), "utf-8");
      return { exitCode: 0, signal: null, timedOut: false };
    },
    testEnvironment: async () => ({
      adapterType: CAPTURE_ADAPTER_TYPE,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
    models: [],
    supportsLocalAgentJwt: false,
  };
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("dispatcher task-context injection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let testTmpRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-dispatch-task-context-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    testTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-dispatch-task-context-test-"));
  }, 20_000);

  afterEach(async () => {
    const drained = await heartbeat.drainActiveRuns(15_000);
    if (!drained) {
      throw new Error(
        "heartbeat-dispatch-task-context.test.ts: active runs failed to drain within 15s",
      );
    }
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(skills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    unregisterServerAdapter(CAPTURE_ADAPTER_TYPE);
  });

  afterAll(async () => {
    await fs.rm(testTmpRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  async function setupCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip-test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("non-guild agent with assigned issue receives taskId/taskTitle/taskBody on ctx.config", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `ctx-non-guild-${agentId}.json`);

    registerServerAdapter(buildCaptureAdapter(dumpPath));

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "non-guild-agent",
      role: "engineer",
      status: "idle",
      adapterType: CAPTURE_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement task-context injection",
      description: "Wire taskId/taskTitle/taskBody into ctx.config so workers can see their assignment.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const queued = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId },
      "manual",
    );
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8")) as {
      hasTaskId: boolean;
      taskId: unknown;
      taskTitle: unknown;
      taskBody: unknown;
    };
    expect(dumped.hasTaskId).toBe(true);
    expect(dumped.taskId).toBe(issueId);
    expect(dumped.taskTitle).toBe("Implement task-context injection");
    expect(dumped.taskBody).toBe(
      "Wire taskId/taskTitle/taskBody into ctx.config so workers can see their assignment.",
    );
  }, 30_000);

  it("guild agent with assigned issue still receives taskId/taskTitle/taskBody", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `ctx-guild-${agentId}.json`);

    registerServerAdapter(buildCaptureAdapter(dumpPath));

    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "guild-bundle-"));
    await fs.writeFile(
      path.join(bundleRoot, "autonomy.json"),
      JSON.stringify({ version: 1, guildName: "test-guild", autonomous: ["read"] }),
      "utf-8",
    );

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "test-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: CAPTURE_ADAPTER_TYPE,
        instructionsRootPath: bundleRoot,
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Guild task assignment",
      description: "Body for a guild-dispatched task.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const queued = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId },
      "manual",
    );
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8")) as {
      hasTaskId: boolean;
      taskId: unknown;
      taskTitle: unknown;
      taskBody: unknown;
    };
    expect(dumped.hasTaskId).toBe(true);
    expect(dumped.taskId).toBe(issueId);
    expect(dumped.taskTitle).toBe("Guild task assignment");
    expect(dumped.taskBody).toBe("Body for a guild-dispatched task.");
  }, 30_000);

  it("issueless heartbeat wake leaves taskId absent on ctx.config", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `ctx-no-issue-${agentId}.json`);

    registerServerAdapter(buildCaptureAdapter(dumpPath));

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "issueless-agent",
      role: "engineer",
      status: "idle",
      adapterType: CAPTURE_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // No issueId in the context snapshot, no issue row: this is the
    // generic issueless heartbeat wake.
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8")) as {
      hasTaskId: boolean;
    };
    expect(dumped.hasTaskId).toBe(false);
  }, 30_000);

  it("issue with null description: taskBody is empty string (not the string 'null')", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `ctx-null-desc-${agentId}.json`);

    registerServerAdapter(buildCaptureAdapter(dumpPath));

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "null-desc-agent",
      role: "engineer",
      status: "idle",
      adapterType: CAPTURE_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Title only, no body",
      description: null,
      status: "in_progress",
      priority: "low",
      assigneeAgentId: agentId,
    });

    const queued = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId },
      "manual",
    );
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8")) as {
      hasTaskId: boolean;
      taskId: unknown;
      taskTitle: unknown;
      taskBody: unknown;
    };
    expect(dumped.hasTaskId).toBe(true);
    expect(dumped.taskId).toBe(issueId);
    expect(dumped.taskTitle).toBe("Title only, no body");
    expect(dumped.taskBody).toBe("");
  }, 30_000);
});
