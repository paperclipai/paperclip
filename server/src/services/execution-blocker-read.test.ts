import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker PostgreSQL read projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}, extraEvidence: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocker fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Blocker agent", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocker task", status: "blocked", assigneeAgentId: agentId });
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: "adapter_failed", error: "Fixture failure", contextSnapshot: { issueId, prompt: payload },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { instructions: payload } }, instructions: payload },
      stdoutExcerpt: payload, ...patch,
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: run.id, status: "active", nextAction: "Inspect the source run.",
      evidence: { runId: run.id, ...extraEvidence } });
    return { companyId, agentId, issueId, run };
  }

  function recordRunReads(fullRows = false) {
    const reads: unknown[][] = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = args[0] === heartbeatRuns && fullRows ? target.select().from(heartbeatRuns) : from(...args);
          if (args[0] === heartbeatRuns) {
            const execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const rows = await execute(...executeArgs); reads.push(rows); return rows;
            };
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    return { recorded, reads };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>) {
    const baseline = recordRunReads(true), projected = recordRunReads();
    const expected = await getExecutionBlocker(baseline.recorded, f.companyId, f.issueId);
    const result = await getExecutionBlocker(projected.recorded, f.companyId, f.issueId);
    expect(expected).not.toBeNull();
    expect(result).toEqual(expected);
    expect(projected.reads).toHaveLength(baseline.reads.length);
    expect(projected.reads.flat()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected.reads))).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(baseline.reads))).toBeGreaterThan(128 * 1024);
    return result;
  }

  it("preserves blocker and retry decisions without returning prompts, profiles, or output", async () => {
    const f = await fixture();
    expect(await compare(f)).toMatchObject({ runId: f.run.id, agentId: f.agentId, canRetry: true, canContinue: false });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect(await getExecutionBlocker(db, randomUUID(), f.issueId)).toBeNull();
  });

  it("retains the claimed adapter and startup receipts for a cancelled pre-provider run", async () => {
    const f = await fixture({ status: "cancelled", startedAt: null, errorCode: "operator_interrupted",
      resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: "2020-01-01T00:01:00Z" } });
    expect(await compare(f)).toMatchObject({ canRetry: true, canContinue: false });
    await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
  });

  it.each(["valid", "number", "missing"])("preserves typed pre-dispatch interaction evidence (%s)", async kind => {
    const context = { source: "connection_intent.resolved", connectionIntentResolution: "existing_connection",
      interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction",
      ...(kind === "missing" ? {} : { interactionId: kind === "valid" ? randomUUID() : 42 }) };
    const f = await fixture({ status: "cancelled", errorCode: "issue_waiting_for_response", contextSnapshot: context,
      resultJson: { stopReason: "issue_waiting_for_response", timeoutSource: "stale_queued_run_gate",
        preDispatchResponseWait: { version: 1, providerWorkStarted: false } } });
    expect(await compare(f)).toMatchObject({ canRetry: kind === "valid" });
  });

  it.each([true, false])("preserves native no-workspace evidence and cwd presence (%s)", async hasCwd => {
    const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
      workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
    });
    const input = { schema: "paperclip.native-execution-input.v6",
      binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
      provider: { kind: "grok_bot" }, workspace: { access: "none", ...(hasCwd ? { cwd: null } : {}) },
      task: { description: randomBytes(128 * 1024).toString("base64") },
      runtimeContext: { instructions: randomBytes(128 * 1024).toString("base64") } };
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
      runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: input } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await compare(f)).toMatchObject({ workspaceRepairRequired: !hasCwd, canRetry: false });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(stored.runnerProfileJson?.nativeExecutionInput).toEqual(input);
  });

  it.each(["run", "company", "agent", "issue", "provider", "schema", "access", "workspace", "binding", "missing_binding",
    "null_input", "array_input", "scalar_input", "number_input"])(
    "does not relax native workspace recovery for invalid input (%s)", async kind => {
      const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
        workspaceRestoreFailure: "restore_unsafe_archive",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
      });
      const input: Record<string, unknown> = {
        schema: "paperclip.native-execution-input.v6",
        binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
        provider: { kind: "grok_bot" }, workspace: { access: "none", cwd: null },
        task: { description: randomBytes(128 * 1024).toString("base64") },
      };
      const binding = input.binding as Record<string, unknown>;
      if (kind === "run") binding.runId = randomUUID();
      if (kind === "company") binding.companyId = randomUUID();
      if (kind === "agent") binding.agentId = randomUUID();
      if (kind === "issue") binding.issueId = randomUUID();
      if (kind === "provider") input.provider = { kind: "codex" };
      if (kind === "schema") input.schema = "unsupported";
      if (kind === "access") input.workspace = { cwd: null };
      if (kind === "workspace") input.workspace = "none";
      if (kind === "binding") input.binding = [];
      if (kind === "missing_binding") delete input.binding;
      const selectedInput = kind === "null_input" ? null : kind === "array_input" ? []
        : kind === "scalar_input" ? "input" : kind === "number_input" ? 42 : input;
      await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
        runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: selectedInput } }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await compare(f)).toMatchObject({ workspaceRepairRequired: true, canRetry: false });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].runnerProfileJson?.nativeExecutionInput).toEqual(selectedInput);
    },
  );

  it.each([null, [], "scalar", 42, { issueId: 42, taskId: false }].map(context => ({ context })))("preserves decisions for malformed context $context", async ({ context }) => {
    const f = await fixture({ contextSnapshot: context as Record<string, unknown> | null });
    expect(await compare(f)).toMatchObject({ canRetry: true });
  });
});
