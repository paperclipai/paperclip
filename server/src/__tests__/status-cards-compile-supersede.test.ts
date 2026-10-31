import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describeEmbeddedPostgres("status card generation run cancellation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executors: Array<{ runId: string; child: ReturnType<typeof spawn> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-cards-compile-supersede-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
  }, 20_000);

  afterEach(() => {
    for (const { runId, child } of executors.splice(0)) {
      runningProcesses.delete(runId);
      child.kill("SIGKILL");
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup() {
    const company = await db.insert(companies).values({ name: "Co", issuePrefix: `SC${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    const summarizer = await db.insert(agents).values({
      companyId: company.id,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    }).returning().then((rows) => rows[0]!);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", statusCardRoutes(db, { heartbeat: { wakeup: async () => ({ queued: true }) } }));
    app.use(errorHandler);
    const created = await request(app).post(`/api/companies/${company.id}/status-cards`).send({ interestPrompt: "Blocked launch tasks" });
    expect(created.status).toBe(201);
    return { app, company, summarizer, card: created.body as { id: string; generatingIssueId: string } };
  }

  async function startGenerationRun(
    input: Awaited<ReturnType<typeof setup>>,
    options: { linkExecutionRun: boolean },
  ) {
    const issueId = input.card.generatingIssueId;
    const run = await db.insert(heartbeatRuns).values({
      companyId: input.company.id,
      agentId: input.summarizer.id,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    }).returning().then((rows) => rows[0]!);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    executors.push({ runId: run.id, child });
    runningProcesses.set(run.id, { child, graceSec: 0, processGroupId: null });
    await issueService(db).update(issueId, { status: "in_progress" });
    if (options.linkExecutionRun) {
      await db.update(issues).set({ checkoutRunId: run.id, executionRunId: run.id }).where(eq(issues.id, issueId));
    }
    return { issueId, runId: run.id, pid: child.pid! };
  }

  async function runStatus(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]?.status);
  }

  async function issueStatus(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  }

  it.each([true, false])("stops the displaced compile executor when a prompt edit supersedes it (executionRunId linked=%s)", async (linkExecutionRun) => {
    const input = await setup();
    const displaced = await startGenerationRun(input, { linkExecutionRun });
    expect(isPidAlive(displaced.pid)).toBe(true);

    const patched = await request(input.app).patch(`/api/status-cards/${input.card.id}`).send({ interestPrompt: "Done launch tasks" });

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ state: "compiling", failureReason: null });
    expect(patched.body.generatingIssueId).not.toBe(displaced.issueId);
    expect(await issueStatus(displaced.issueId)).toBe("cancelled");
    expect(await runStatus(displaced.runId)).toBe("cancelled");
    expect(await waitForPidExit(displaced.pid)).toBe(true);
    expect(await issueStatus(patched.body.generatingIssueId)).toBe("todo");
  });

  it("stops the in-flight generation executor when its card is archived", async () => {
    const input = await setup();
    const inFlight = await startGenerationRun(input, { linkExecutionRun: true });

    const archived = await request(input.app).patch(`/api/status-cards/${input.card.id}`).send({ archived: true });

    expect(archived.status).toBe(200);
    expect(archived.body.generatingIssueId).toBeNull();
    expect(await issueStatus(inFlight.issueId)).toBe("cancelled");
    expect(await runStatus(inFlight.runId)).toBe("cancelled");
    expect(await waitForPidExit(inFlight.pid)).toBe(true);
  });

  it("leaves an unrelated running executor of the summarizer alone", async () => {
    const input = await setup();
    const unrelatedIssue = await issueService(db).create(input.company.id, { title: "Unrelated", status: "todo", assigneeAgentId: input.summarizer.id });
    const run = await db.insert(heartbeatRuns).values({
      companyId: input.company.id,
      agentId: input.summarizer.id,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: unrelatedIssue.id },
    }).returning().then((rows) => rows[0]!);

    const patched = await request(input.app).patch(`/api/status-cards/${input.card.id}`).send({ interestPrompt: "Done launch tasks" });

    expect(patched.status).toBe(200);
    expect(await issueStatus(input.card.generatingIssueId)).toBe("cancelled");
    expect(await runStatus(run.id)).toBe("running");
  });
});
