import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, heartbeatRuns, budgetPolicies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const root = fileURLToPath(new URL("../../..", import.meta.url));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, diagnostic: () => string = () => "", timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Accounting process checkpoint timed out. ${diagnostic()}`);
}

(support.supported && process.platform !== "win32" ? describe : describe.skip)("accounting survives real server SIGKILL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-crash-"); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  it.each(["before_receipt", "before_runtime_totals", "before_commit", "after_commit_before_delivery_ack"] as const)("recovers exactly once after %s", async (phase) => {
    const db = createDb(database.connectionString);
    const observer = createDb(database.connectionString).$client;
    const blocker = await createDb(database.connectionString).$client.reserve();
    const home = await mkdtemp(path.join(tmpdir(), "pc-accounting-kill-"));
    const key = randomInt(1, 2_000_000_000);
    const [company] = await db.insert(companies).values({ name: "Crash accounting", issuePrefix: `K${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false } } }).returning();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1, notifyEnabled: false }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "failed", finishedAt: new Date(), costAccountingPending: true,
      usageJson: { accountingReceiptReady: true, provider: "fixture", model: "fixture", billingType: "metered_api", inputTokens: 7, cachedInputTokens: 11, outputTokens: 3, costUsd: 0.0125 },
    }).returning();
    const table = phase === "before_receipt" ? "cost_events" : phase === "before_runtime_totals" ? "agent_runtime_state"
      : phase === "before_commit" ? "heartbeat_runs" : "budget_policies";
    const event = phase === "after_commit_before_delivery_ack" || phase === "before_commit" ? "UPDATE" : "INSERT";
    const condition = phase === "after_commit_before_delivery_ack" ? "AND NEW.enforcement_delivered_version > OLD.enforcement_delivered_version"
      : phase === "before_commit" ? "AND OLD.cost_accounting_pending = false AND NEW.cost_accounted_at IS NOT NULL" : "";
    let child: ChildProcess | undefined;
    let logs = "";
    async function kill() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      process.kill(-child.pid!, "SIGKILL");
      await stopped;
    }
    async function start() {
      const port = await new Promise<number>((resolve, reject) => {
        const listener = createServer(); listener.on("error", reject);
        listener.listen(0, "127.0.0.1", () => { const address = listener.address() as { port: number }; listener.close(() => resolve(address.port)); });
      });
      logs = "";
      child = spawn(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", "server/src/index.ts"], {
        cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          NODE_ENV: "test", DATABASE_URL: database.connectionString, PORT: String(port),
          PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: path.join(home, "config.json"), PAPERCLIP_INSTANCE_ID: "accounting-crash",
          PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_BIND: "loopback", SERVE_UI: "false",
          PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_TELEMETRY_DISABLED: "1", PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
          HEARTBEAT_SCHEDULER_ENABLED: "false", PAPERCLIP_DECISION_SIGNING_SECRET: "accounting-crash-test-decision-secret",
          PAPERCLIP_AGENT_JWT_SECRET: "accounting-crash-test-agent-secret",
        },
      });
      const capture = (data: Buffer) => { logs = (logs + data.toString()).slice(-16000); };
      child.stdout!.on("data", capture); child.stderr!.on("data", capture);
      return `http://127.0.0.1:${port}`;
    }
    try {
      await blocker`SELECT pg_advisory_lock(${key})`;
      await observer.unsafe(`CREATE FUNCTION accounting_crash_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.company_id = '${company.id}'::uuid ${condition} THEN PERFORM pg_advisory_lock(${key}); END IF; RETURN NEW; END $$;
        CREATE TRIGGER accounting_crash_barrier BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting_crash_barrier()`);
      await start();
      const waiting = await until(() => {
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Accounting server exited before the barrier: ${logs}`);
        return observer`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`;
      }, rows => rows.length > 0, () => logs);
      const committed = phase === "after_commit_before_delivery_ack";
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id))).toHaveLength(committed ? 1 : 0);
      await kill();
      expect(child?.signalCode).toBe("SIGKILL");
      // A backend blocked inside our artificial barrier cannot observe its
      // dead client until the query returns. Terminate that orphan connection
      // before releasing the barrier, forcing PostgreSQL's disconnect rollback.
      for (const row of waiting) await observer`SELECT pg_terminate_backend(${row.pid})`;
      await until(() => observer`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`, rows => rows.length === 0);
      await blocker`SELECT pg_advisory_unlock(${key})`;
      await observer.unsafe(`DROP TRIGGER accounting_crash_barrier ON ${table}; DROP FUNCTION accounting_crash_barrier()`);
      const baseUrl = await start();
      await until(() => observer`SELECT cost_accounting_pending,cost_accounted_at FROM heartbeat_runs WHERE id=${run.id}`,
        rows => rows[0].cost_accounting_pending === false && rows[0].cost_accounted_at !== null, () => logs);
      await until(() => observer`SELECT enforcement_version,enforcement_delivered_version FROM budget_policies WHERE id=${policy.id}`,
        rows => rows[0].enforcement_version > 0 && rows[0].enforcement_version === rows[0].enforcement_delivered_version, () => logs);
      const assertLedger = async () => {
        expect((await observer`SELECT count(*)::int AS count,sum(cost_cents)::text AS cents FROM cost_events WHERE heartbeat_run_id=${run.id}`)[0]).toEqual({ count: 1, cents: "1.2500000" });
        expect((await observer`SELECT total_input_tokens,total_cached_input_tokens,total_output_tokens,total_cost_cents::text FROM agent_runtime_state WHERE agent_id=${agent.id}`)[0])
          .toEqual({ total_input_tokens: "7", total_cached_input_tokens: "11", total_output_tokens: "3", total_cost_cents: "1.2500000" });
        expect((await observer`SELECT spent_monthly_cents::text,status FROM agents WHERE id=${agent.id}`)[0]).toEqual({ spent_monthly_cents: "1.2500000", status: "paused" });
        expect((await observer`SELECT count(*)::int AS count FROM budget_incidents WHERE policy_id=${policy.id}`)[0].count).toBe(1);
        expect((await observer`SELECT count(*)::int AS count FROM approvals WHERE company_id=${company.id}`)[0].count).toBe(1);
      };
      await assertLedger();
      await until(async () => fetch(`${baseUrl}/api/health`).then(r => r.ok).catch(() => false), Boolean, () => logs);
      await kill();
      const replayUrl = await start();
      await until(async () => fetch(`${replayUrl}/api/health`).then(r => r.ok).catch(() => false), Boolean, () => logs);
      await until(async () => logs.includes(`Server startup recovery complete on 127.0.0.1:${new URL(replayUrl).port}`), Boolean, () => logs);
      await assertLedger();
    } finally {
      await kill();
      await blocker`SELECT pg_advisory_unlock_all()`;
      blocker.release();
      await observer.unsafe(`DROP TRIGGER IF EXISTS accounting_crash_barrier ON ${table}; DROP FUNCTION IF EXISTS accounting_crash_barrier()`);
      await observer.end();
      await rm(home, { recursive: true, force: true });
    }
  }, 150_000);
});
