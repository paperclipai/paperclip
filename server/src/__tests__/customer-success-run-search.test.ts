import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@paperclipai/db";
import { readCustomerSuccessResource } from "../services/customer-success-inspection.js";
import { searchCustomerSuccessRuns } from "../services/customer-success-run-search.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import type { RunLogStore } from "../services/run-log-store.js";
import type { StorageService } from "../storage/types.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("customer-success runs.search", () => {
  let db: schema.Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  const storage = {} as unknown as StorageService;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cs-run-search-test-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    database = await startEmbeddedPostgresTestDatabase("customer-success-run-search-");
    db = schema.createDb(database.connectionString);
  });

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("catches hidden platform errors inside succeeded runs, reports co-occurrence, and redacts excerpts", async () => {
    const [coA, coB] = await db
      .insert(schema.companies)
      .values([
        { name: "SearchCoA", issuePrefix: "SCA" },
        { name: "SearchCoB", issuePrefix: "SCB" },
      ])
      .returning();
    const [agentA] = await db
      .insert(schema.agents)
      .values({ companyId: coA.id, name: "Codex A", adapterType: "codex_local" })
      .returning();
    const [agentB] = await db
      .insert(schema.agents)
      .values({ companyId: coB.id, name: "OpenCode B", adapterType: "opencode_local" })
      .returning();

    const t1 = new Date("2026-11-23T10:00:00.000Z");
    const t2 = new Date("2026-11-24T10:00:00.000Z");
    const t3 = new Date("2026-11-24T12:00:00.000Z");

    const [runBoth, runGitOnly] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: coA.id,
          agentId: agentA.id,
          status: "succeeded",
          exitCode: 0,
          runtimeMode: "native",
          driverKind: "codex",
          createdAt: t1,
        },
        {
          companyId: coA.id,
          agentId: agentA.id,
          status: "succeeded",
          exitCode: 0,
          runtimeMode: "native",
          driverKind: "codex",
          createdAt: t2,
        },
      ])
      .returning();
    const [runOtherCo] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: coB.id,
          agentId: agentB.id,
          status: "failed",
          exitCode: 1,
          runtimeMode: "native",
          driverKind: "opencode",
          error: "remote_workspace_archive_failed: exit=75 program=git reason=git_storage_guard_unavailable",
          createdAt: t3,
        },
      ])
      .returning();

    await db.insert(schema.heartbeatRunEvents).values([
      {
        companyId: coA.id,
        runId: runBoth.id,
        agentId: agentA.id,
        seq: 1,
        eventType: "item.completed",
        stream: "system",
        payload: {
          prpEvent: {
            payload: {
              kind: "commandExecution",
              aggregatedOutput:
                "Paperclip: GitHub capability_missing; continuing without managed credentials.\n" +
                "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured; Git did not complete.",
            },
          },
        },
      },
      {
        companyId: coA.id,
        runId: runBoth.id,
        agentId: agentA.id,
        seq: 2,
        eventType: "platform.diagnostic",
        stream: "system",
        message: "git_storage_guard_unavailable",
        payload: { code: "git_storage_guard_unavailable" },
      },
      {
        companyId: coA.id,
        runId: runGitOnly.id,
        agentId: agentA.id,
        seq: 1,
        eventType: "item.completed",
        stream: "system",
        payload: {
          prpEvent: {
            payload: {
              kind: "commandExecution",
              aggregatedOutput:
                "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured.",
            },
          },
        },
      },
    ]);

    // Company-scoped search with excerpts returns redacted matches and co-occurrence.
    const scoped = (await readCustomerSuccessResource(db, storage, {
      operation: "runs.search",
      companyId: coA.id,
      patterns: ["paperclip_git_storage_limit", "capability_missing"],
      createdAfter: "2026-11-23T00:00:00.000Z",
      includeExcerpts: true,
    })) as {
      runsScanned: number;
      runsTotalInWindow: number;
      truncated: boolean;
      byDiagnostic: Record<string, number>;
      patterns: Array<{
        pattern: string;
        matchedRuns: number;
        byStatus: Record<string, number>;
        sampleRuns: Array<{ runId: string; excerpt?: string; diagnostics: string[] }>;
      }>;
      coOccurrence: Array<{ patterns: string[]; matchedRuns: number }>;
    };
    expect(scoped.runsScanned).toBe(2);
    expect(scoped.runsTotalInWindow).toBe(2);
    expect(scoped.truncated).toBe(false);
    expect(scoped.byDiagnostic).toEqual({ git_storage_guard_unavailable: 1 });
    expect(scoped.patterns[0]!.matchedRuns).toBe(2);
    expect(scoped.patterns[0]!.byStatus).toEqual({ succeeded: 2 });
    expect(scoped.patterns[0]!.sampleRuns[0]!.excerpt).toContain("paperclip_git_storage_limit");
    expect(scoped.patterns[1]!.matchedRuns).toBe(1);
    expect(scoped.coOccurrence).toEqual([
      { patterns: ["paperclip_git_storage_limit"], matchedRuns: 1 },
      { patterns: ["paperclip_git_storage_limit", "capability_missing"], matchedRuns: 1 },
    ]);

    // Stack-wide search (no companyId, zero excerpts) spans both companies on the stack.
    const stackWide = (await readCustomerSuccessResource(db, storage, {
      operation: "runs.search",
      patterns: ["paperclip_git_storage_limit", "git_storage_guard_unavailable"],
      createdAfter: "2026-11-23T00:00:00.000Z",
      createdBefore: "2026-11-25T00:00:00.000Z",
    })) as {
      runsScanned: number;
      patterns: Array<{ pattern: string; matchedRuns: number; sampleRuns: Array<{ runId: string; excerpt?: string }> }>;
    };
    expect(stackWide.runsScanned).toBe(3);
    expect(stackWide.patterns[0]!.matchedRuns).toBe(2);
    // Matches both runOtherCo (run.error) and runBoth (platform.diagnostic event).
    expect(stackWide.patterns[1]!.matchedRuns).toBe(2);
    expect(stackWide.patterns[1]!.sampleRuns.map((r) => r.runId)).toContain(runOtherCo.id);
    expect(stackWide.patterns[1]!.sampleRuns.map((r) => r.runId)).toContain(runBoth.id);
    expect(stackWide.patterns[0]!.sampleRuns[0]!.excerpt).toBeUndefined();

    // Stack-wide count (no companyId) counts across all companies on the stack.
    const allRunCount = (await readCustomerSuccessResource(db, storage, {
      operation: "count",
      resource: "runs",
    })) as { total: number; byStatus: Record<string, number> };
    expect(allRunCount.total).toBeGreaterThanOrEqual(3);

    // Summary view attaches structured diagnostics on succeeded runs.
    const summaryRun = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "runs",
      companyId: coA.id,
      resourceId: runBoth.id,
      view: "summary",
    })) as { status: string; diagnostics: string[] };
    expect(summaryRun.status).toBe("succeeded");
    expect(summaryRun.diagnostics).toEqual(["git_storage_guard_unavailable"]);
  });

  it("redacts registered secrets before excerpt slicing, across paged log edges, decodes escaped literals, and marks unreadable/slow logs truncated", async () => {
    const [co] = await db
      .insert(schema.companies)
      .values({ name: "SearchEdgeCo", issuePrefix: "SEC" })
      .returning();
    const [agent] = await db
      .insert(schema.agents)
      .values({ companyId: co.id, name: "EdgeAgent", adapterType: "codex_local" })
      .returning();

    // 1) Secret crossing the 240-char excerpt boundary AND a multiline secret must be
    // redacted in full BEFORE slicing or whitespace collapsing.
    const boundarySecret = "sk-boundary-secret-0123456789abcdef-tail";
    const multilineSecret = "BEGIN-SECRET-LINE1\nMIDDLE-SECRET-LINE2\nEND-SECRET-LINE3";
    const [secretRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
      })
      .returning();
    const redactions = createRunSecretRedactionRegistry(db);
    await redactions.register(co.id, secretRun.id, boundarySecret);
    await redactions.register(co.id, secretRun.id, multilineSecret);

    await db.insert(schema.heartbeatRunEvents).values({
      companyId: co.id,
      runId: secretRun.id,
      agentId: agent.id,
      seq: 1,
      eventType: "item.completed",
      stream: "system",
      payload: {
        prpEvent: {
          payload: {
            kind: "commandExecution",
            aggregatedOutput:
              `MARKER_BOUNDARY ${"x".repeat(100)} ${boundarySecret} ` +
              `and multiline ${multilineSecret} plus say "hello"\\world`,
          },
        },
      },
    });

    const redactedSearch = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["MARKER_BOUNDARY", 'say "hello"\\world'],
      includeExcerpts: true,
    });
    expect(redactedSearch.patterns[0]!.matchedRuns).toBe(1);
    const boundaryExcerpt = redactedSearch.patterns[0]!.sampleRuns[0]!.excerpt ?? "";
    expect(boundaryExcerpt).toContain("MARKER_BOUNDARY");
    expect(boundaryExcerpt).not.toContain("sk-boundary");
    expect(boundaryExcerpt).not.toContain("0123456789");
    expect(boundaryExcerpt).not.toContain("BEGIN-SECRET");
    expect(boundaryExcerpt).not.toContain("MIDDLE-SECRET");
    // Literal pattern with quotes and backslash matches decoded JSON payload.
    expect(redactedSearch.patterns[1]!.matchedRuns).toBe(1);
    const escapedExcerpt = redactedSearch.patterns[1]!.sampleRuns[0]!.excerpt ?? "";
    expect(escapedExcerpt).toContain('say "hello"\\world');
    expect(escapedExcerpt).not.toContain("BEGIN-SECRET");
    expect(escapedExcerpt).not.toContain("END-SECRET");

    // 2) Legacy RunLogStore fallback: decodes NDJSON chunks, preserves UTF-8 split
    // across read boundaries, and marks failed or timed-out log reads truncated.
    const [logRun, missingLogRun, slowLogRun] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "utf8-and-quotes.ndjson",
        },
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "missing.ndjson",
        },
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "slow.ndjson",
        },
      ])
      .returning();

    const ndjsonBytes = Buffer.from(
      `${JSON.stringify({ ts: "2026-11-25T00:00:00Z", stream: "stderr", chunk: 'prefix café 🚀 say "quoted"\n' })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:01Z", stream: "stderr", chunk: "tail line" })}\n`,
      "utf8",
    );

    const makeFakeStore = (mode: "utf8" | "missing" | "slow"): RunLogStore => ({
      begin: async () => ({ store: "local_file", logRef: "unused" }),
      append: async () => 0,
      finalize: async () => ({ bytes: 0, compressed: false }),
      read: async (handle, opts) => {
        if (handle.logRef === "utf8-and-quotes.ndjson" && mode === "utf8") {
          const offset = opts?.offset ?? 0;
          // Force a tiny 45-byte page that cuts straight through multibyte UTF-8 / JSON.
          const step = Math.min(45, opts?.limitBytes ?? 45);
          const slice = ndjsonBytes.subarray(offset, offset + step);
          const nextOffset = offset + slice.length < ndjsonBytes.length ? offset + slice.length : undefined;
          return { content: slice.toString("utf8"), nextOffset };
        }
        if (handle.logRef === "missing.ndjson") {
          throw new Error("ENOENT: log missing after pod roll");
        }
        if (handle.logRef === "slow.ndjson" && mode === "slow") {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { content: "" };
      },
    });

    // UTF-8 split & JSON-escaped quotes match cleanly when log is readable.
    const utf8Only = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ['café 🚀 say "quoted"'],
      },
      {
        logStore: {
          ...makeFakeStore("utf8"),
          read: async (handle, opts) =>
            handle.logRef === "utf8-and-quotes.ndjson"
              ? makeFakeStore("utf8").read(handle, opts)
              : { content: "" },
        },
      },
    );
    expect(utf8Only.truncated).toBe(false);
    expect(utf8Only.patterns[0]!.matchedRuns).toBe(1);
    expect(utf8Only.patterns[0]!.sampleRuns[0]!.runId).toBe(logRun.id);

    // Failed log read sets truncated: true rather than reporting a clean negative.
    const missingResult = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["never-matches-anything"],
      },
      { logStore: makeFakeStore("missing") },
    );
    expect(missingResult.truncated).toBe(true);
    expect(missingLogRun.id).toBeTruthy();

    // Slow log read is aborted by wallBudgetMs and sets truncated: true promptly.
    const started = Date.now();
    const slowResult = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["never-matches-anything"],
      },
      { logStore: makeFakeStore("slow"), wallBudgetMs: 200 },
    );
    expect(slowResult.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slowLogRun.id).toBeTruthy();

    // 3) Truncated search (limit: 1 with >1 runs in window) MUST still load redactors
    // and redact registered secrets from fallback RunLogStore excerpts — including a
    // secret split across two paged log chunks on both left and right edges!
    const leftEdgeSecret = "sk-left-edge-secret-aaaa1111bbbb2222";
    const rightEdgeSecret = "sk-right-edge-secret-cccc3333dddd4444";
    const [newestLogRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "legacy",
        driverKind: "codex",
        logStore: "local_file",
        logRef: "truncated-secret.ndjson",
        createdAt: new Date(Date.now() + 60_000),
      })
      .returning();
    await redactions.register(co.id, newestLogRun.id, leftEdgeSecret);
    await redactions.register(co.id, newestLogRun.id, rightEdgeSecret);
    const secretNdjsonBytes = Buffer.from(
      `${JSON.stringify({ ts: "2026-11-25T00:00:00Z", stream: "stderr", chunk: "sk-left-edge-" })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:01Z", stream: "stderr", chunk: "secret-aaaa1111bbbb2222 TRUNCATED_MARKER sk-right-edge-" })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:02Z", stream: "stderr", chunk: "secret-cccc3333dddd4444 end\n" })}\n`,
      "utf8",
    );
    const truncatedRedacted = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["TRUNCATED_MARKER"],
        limit: 1,
        includeExcerpts: true,
      },
      {
        logStore: {
          begin: async () => ({ store: "local_file", logRef: "unused" }),
          append: async () => 0,
          finalize: async () => ({ bytes: 0, compressed: false }),
          read: async (handle, opts) => {
            if (handle.logRef !== "truncated-secret.ndjson") return { content: "" };
            const offset = opts?.offset ?? 0;
            const step = Math.min(115, opts?.limitBytes ?? 115);
            const slice = secretNdjsonBytes.subarray(offset, offset + step);
            const nextOffset = offset + slice.length < secretNdjsonBytes.length ? offset + slice.length : undefined;
            return { content: slice.toString("utf8"), nextOffset };
          },
        },
      },
    );
    expect(truncatedRedacted.truncated).toBe(true);
    expect(truncatedRedacted.patterns[0]!.matchedRuns).toBe(1);
    const truncExcerpt = truncatedRedacted.patterns[0]!.sampleRuns[0]!.excerpt ?? "";
    expect(truncExcerpt).toContain("TRUNCATED_MARKER");
    expect(truncExcerpt).not.toContain("sk-left-edge");
    expect(truncExcerpt).not.toContain("aaaa1111");
    expect(truncExcerpt).not.toContain("sk-right-edge");
    expect(truncExcerpt).not.toContain("cccc3333");

    // 4) Matches after early JSON-key-only hits (e.g. searching "output" when early
    // events have key "aggregatedOutput" without "output" in their values) are found
    // consistently both with and without includeExcerpts.
    const [lateMatchRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
        createdAt: new Date(Date.now() + 120_000),
      })
      .returning();
    await db.insert(schema.heartbeatRunEvents).values([
      ...Array.from({ length: 5 }, (_, idx) => ({
        companyId: co.id,
        runId: lateMatchRun.id,
        agentId: agent.id,
        seq: idx + 1,
        eventType: "item.completed",
        stream: "system",
        payload: { aggregatedOutput: `benign line ${idx}` },
      })),
      {
        companyId: co.id,
        runId: lateMatchRun.id,
        agentId: agent.id,
        seq: 6,
        eventType: "item.completed",
        stream: "system",
        payload: { aggregatedOutput: "real output match on event 6" },
      },
    ]);
    const withoutExcerpts = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["output"],
      limit: 1,
      includeExcerpts: false,
    });
    const withExcerpts = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["output"],
      limit: 1,
      includeExcerpts: true,
    });
    expect(withoutExcerpts.patterns[0]!.matchedRuns).toBe(1);
    expect(withExcerpts.patterns[0]!.matchedRuns).toBe(1);
    expect(withExcerpts.patterns[0]!.sampleRuns[0]!.excerpt).toContain("real output match on event 6");

    // 5) Historical Drizzle SQL statements and bound params in heartbeat_runs.error
    // are stripped via withoutSqlStatementText before searching or excerpting.
    const [sqlErrRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "failed",
        runtimeMode: "native",
        driverKind: "codex",
        error: "Failed query: select * from secrets where value = $1\nparams: unregistered-sql-param-secret",
        createdAt: new Date(Date.now() + 180_000),
      })
      .returning();
    const sqlSearch = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["unregistered-sql-param-secret", "Database query failed"],
      limit: 1,
      includeExcerpts: true,
    });
    expect(sqlSearch.patterns[0]!.matchedRuns).toBe(0);
    expect(sqlSearch.patterns[1]!.matchedRuns).toBe(1);
    expect(sqlSearch.patterns[1]!.sampleRuns[0]!.runId).toBe(sqlErrRun.id);
    expect(sqlSearch.patterns[1]!.sampleRuns[0]!.excerpt).not.toContain("unregistered-sql-param-secret");

    // 6) Complete registered secret values are removed FIRST before structural redaction
    // can alter any substring inside them, and structural redaction (redactEventPayload)
    // ALSO strips unregistered secret-named keys and bearer tokens.
    const [structRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
        createdAt: new Date(Date.now() + 240_000),
      })
      .returning();
    const compositeRegisteredSecret = "prefix-keep-out Bearer inner-token-123 suffix-keep-out";
    await redactions.register(co.id, structRun.id, compositeRegisteredSecret);
    await db.insert(schema.heartbeatRunEvents).values({
      companyId: co.id,
      runId: structRun.id,
      agentId: agent.id,
      seq: 1,
      eventType: "item.completed",
      stream: "system",
      payload: {
        apiKey: "unregistered-api-key-secret-value",
        aggregatedOutput:
          `STRUCT_REDACT_MARKER ${compositeRegisteredSecret} ` +
          `authorization=Bearer unregistered-bearer-token-999`,
      },
    });
    const structSearch = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["unregistered-api-key-secret-value", "STRUCT_REDACT_MARKER"],
      limit: 1,
      includeExcerpts: true,
    });
    expect(structSearch.patterns[0]!.matchedRuns).toBe(0);
    expect(structSearch.patterns[1]!.matchedRuns).toBe(1);
    const structExcerpt = structSearch.patterns[1]!.sampleRuns[0]!.excerpt ?? "";
    expect(structExcerpt).toContain("STRUCT_REDACT_MARKER");
    expect(structExcerpt).not.toContain("prefix-keep-out");
    expect(structExcerpt).not.toContain("suffix-keep-out");
    expect(structExcerpt).not.toContain("unregistered-bearer-token-999");
  });
});
