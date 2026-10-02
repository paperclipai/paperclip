import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, environmentLeases, environments,
  heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { adapterExecutionControls } from "../services/adapter-execution-control.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Hermes host lifecycle");
}

describeDatabase("Hermes durable reconciliation after unconfirmed Stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let environmentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-hermes-hold-");
    db = createDb(database.connectionString);
    await db.insert(environments).values({ name: "Local", driver: "local" }).onConflictDoNothing();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    environmentId = environment.id;
  }, 120_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.$client.end({ timeout: 0 });
    await database.cleanup();
  });

  it.each([
    { outcome: "ambiguous create", code: "hermes_gateway_create_outcome_unknown", knownId: false },
    { outcome: "known-ID unconfirmed stop", code: "hermes_gateway_stop_unconfirmed", knownId: true },
  ].flatMap(scenario => [true, false].map(boardStop => ({ ...scenario, boardStop }))))(
    "retains queued work after $outcome (board Stop: $boardStop)", async ({ code, knownId, boardStop }) => {
    let creates = 0;
    let observations = 0;
    let stops = 0;
    let reservationStops = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/v1/runs") {
        creates++;
        // Unknown create deliberately never supplies an ID, even after Stop.
        if (knownId) res.end(JSON.stringify({ run_id: "synthetic-run", status: "running" }));
      } else if (req.url === "/v1/run-reservations/stop") {
        reservationStops++;
        res.writeHead(404).end("{}");
      } else if (req.url?.endsWith("/stop")) {
        stops++;
        res.end(JSON.stringify({ status: "running" }));
      } else if (req.url?.endsWith("/events")) {
        observations++;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(": keepalive\n\n");
      } else {
        observations++;
        res.end(JSON.stringify({ run_id: "synthetic-run", status: "running" }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback port");
    const heartbeat = heartbeatService(db);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    try {
      await db.insert(companies).values({ id: companyId, name: "Hermes test", issuePrefix,
        requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-board" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Hermes test", role: "engineer",
        status: "idle", adapterType: "hermes_gateway", runtimeConfig: {}, permissions: {},
        adapterConfig: { apiBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-test-key",
          timeoutSec: boardStop ? 120 : 2, pollIntervalMs: 250 } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Unconfirmed provider work",
        status: "todo", priority: "medium", assigneeAgentId: agentId,
        responsibleUserId: "test-board", issueNumber: 1, identifier: `${issuePrefix}-1` });
      async function commentWake(service: ReturnType<typeof heartbeatService>, body: string) {
        const [comment] = await db.insert(issueComments).values({ companyId, issueId,
          authorType: "user", authorUserId: "test-board", body }).returning();
        const run = await service.wakeup(agentId, { source: "automation", triggerDetail: "system",
          reason: "issue_commented", payload: { issueId, commentId: comment.id },
          contextSnapshot: { issueId, taskId: issueId, commentId: comment.id, wakeReason: "issue_commented" },
          requestedByActorType: "user", requestedByActorId: "test-board" });
        return { run, comment };
      }
      const { run } = await commentWake(heartbeat, "Start synthetic work");
      expect(run).not.toBeNull();
      await waitFor(() => creates === 1 && (!knownId || observations > 0));
      expect(adapterExecutionControls.has(run!.id)).toBe(true);
      // A local bookkeeping lease exercises teardown without a remote sandbox.
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId,
        heartbeatRunId: run!.id, environmentId, provider: "local", status: "active" }).returning();
      const queued = await commentWake(heartbeat, "Retain this follow-up");
      expect(queued.run).toBeNull();
      if (boardStop) {
        await expect(heartbeat.cancelRun(run!.id)).rejects.toThrow("provider termination could not be verified");
      }
      await heartbeat.drainActiveRunExecutions();
      const terminal = await heartbeat.getRun(run!.id);
      expect(terminal).toMatchObject({ errorCode: boardStop ? "cancelled" : code, resultJson: {
        stop_confirmed: false, ...(boardStop ? { executionCancellation: { state: "requested" } } : {}),
      } });
      expect(terminal!.status).toBe(boardStop ? "cancelled" : "failed");
      expect(adapterExecutionControls.has(run!.id)).toBe(false);
      expect(creates).toBe(1);
      expect(stops).toBe(knownId ? 1 : 0);
      expect(reservationStops).toBe(knownId ? 0 : 1);
      const [released] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(released.status).toBe(boardStop ? "expired" : "failed");
      expect(released.releasedAt).not.toBeNull();
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task).toMatchObject({ executionRunId: null, checkoutRunId: null });

      // A fresh Node process has none of the original execution-control maps.
      // It runs recovery and a new wake against the persisted terminal outcome.
      const child = await promisify(execFile)(process.execPath, [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        fileURLToPath(new URL("./helpers/hermes-reconciliation-restart.ts", import.meta.url)),
        JSON.stringify({ connectionString: database.connectionString, agentId, issueId, runId: run!.id }),
      ], { timeout: 45_000, maxBuffer: 1_000_000 });
      expect(child.stdout).toContain("hermes-restart-hold-ok");
      const reopened = createDb(database.connectionString);
      try {
        const recovery = heartbeatService(reopened);
        await recovery.reapOrphanedRuns();
        await recovery.reconcileStrandedAssignedIssues();
        await recovery.reconcileResolvedDependencyWakes();
        expect((await commentWake(recovery, "Another wake after reconstruction")).run).toBeNull();
        await recovery.drainActiveRunExecutions();
        const runs = await reopened.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        expect(runs.map(row => row.id)).toEqual([run!.id]);
        const actions = await reopened.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
        expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({
          cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: agentId,
        })]));
        const wakes = await reopened.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
        expect(wakes).toEqual(expect.arrayContaining([expect.objectContaining({
          status: "deferred_issue_execution", payload: expect.objectContaining({ commentId: queued.comment.id }),
        })]));
        const [retained] = await reopened.select().from(issueComments).where(eq(issueComments.id, queued.comment.id));
        expect(retained.body).toBe("Retain this follow-up");
        expect(creates).toBe(1);
      } finally {
        await reopened.$client.end({ timeout: 0 });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await heartbeat.drainActiveRunExecutions();
    }
  }, 90_000);
});
