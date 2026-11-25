import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@paperclipai/db";
import { detectRunPlatformDiagnostics } from "@paperclipai/shared";
import {
  extractRunPlatformDiagnosticsFromEvent,
  listRunPlatformDiagnostics,
  recordRunPlatformDiagnostics,
  reportFinalizedRunDiagnostics,
  RUNTIME_DIAGNOSTICS_CAPABILITY_ENV,
} from "../services/run-platform-diagnostics.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("run platform diagnostics", () => {
  let db: schema.Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-platform-diagnostics-");
    db = schema.createDb(database.connectionString);
    const [company] = await db
      .insert(schema.companies)
      .values({ name: "DiagCo", issuePrefix: "DGC" })
      .returning();
    companyId = company.id;
    const [agent] = await db
      .insert(schema.agents)
      .values({ companyId, name: "Codex", adapterType: "codex_local" })
      .returning();
    agentId = agent.id;
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("classifies git storage guard, github capability, and disk full markers cleanly", () => {
    expect(
      detectRunPlatformDiagnostics(
        "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured; Git did not complete.",
      ),
    ).toEqual(["git_storage_guard_unavailable"]);

    expect(
      detectRunPlatformDiagnostics(
        "paperclip_git_storage_limit: The sandbox has too little free disk space or too few free inodes; Git did not start.",
      ),
    ).toEqual(["git_storage_limit", "sandbox_disk_full"]);

    // Storage budget refusal is NOT disk/inode exhaustion.
    expect(
      detectRunPlatformDiagnostics(
        "paperclip_git_storage_limit: Git stopped at its storage budget.",
      ),
    ).toEqual(["git_storage_limit"]);

    // Arbitrary customer command output unrelated to sandbox disk exhaustion is ignored.
    expect(
      detectRunPlatformDiagnostics("customer script stderr: No space left on device"),
    ).toEqual([]);

    expect(
      detectRunPlatformDiagnostics(
        "Paperclip: GitHub capability_missing; continuing without managed credentials.\n" +
          "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured.",
      ),
    ).toEqual(["git_storage_guard_unavailable", "github_capability_missing"]);

    expect(detectRunPlatformDiagnostics("ordinary git clone succeeded")).toEqual([]);
  });

  it("extracts diagnostics from native PRP commandExecution payloads", () => {
    expect(
      extractRunPlatformDiagnosticsFromEvent("item.completed", null, {
        prpEvent: {
          payload: {
            kind: "commandExecution",
            aggregatedOutput:
              "Paperclip: GitHub capability_rejected; token denied\n" +
              "remote_workspace_archive_failed: reason=git_storage_guard_unavailable",
          },
        },
      }),
    ).toEqual(["git_storage_guard_unavailable", "github_capability_rejected"]);
  });

  it("deduplicates persisted platform.diagnostic rows and posts PII-free reports to Cloud", async () => {
    const [run] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "succeeded",
        exitCode: 0,
        runtimeMode: "native",
        driverKind: "codex",
      })
      .returning();

    const sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      sent.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ recorded: 2 }), { status: 200 });
    });

    const env = {
      PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test",
      PAPERCLIP_PRIMARY_HOST: "tenant.example.test",
      [RUNTIME_DIAGNOSTICS_CAPABILITY_ENV]: "a".repeat(64),
    };

    const first = await recordRunPlatformDiagnostics(
      db,
      {
        companyId,
        runId: run.id,
        agentId,
        codes: ["git_storage_guard_unavailable", "github_capability_missing"],
        runStatus: "running",
        driverKind: "codex",
        runtimeMode: "native",
      },
      { env, fetcher },
    );
    expect(first).toEqual(["git_storage_guard_unavailable", "github_capability_missing"]);

    // Second recording for the same run/codes is idempotent (no duplicate DB rows, no extra Cloud POST).
    const second = await recordRunPlatformDiagnostics(
      db,
      {
        companyId,
        runId: run.id,
        agentId,
        codes: ["git_storage_guard_unavailable"],
        runStatus: "running",
        driverKind: "codex",
        runtimeMode: "native",
      },
      { env, fetcher },
    );
    expect(second).toEqual([]);
    expect(sent).toHaveLength(1);

    const listed = await listRunPlatformDiagnostics(db, [run.id], companyId);
    expect(listed.get(run.id)).toEqual([
      "git_storage_guard_unavailable",
      "github_capability_missing",
    ]);

    // Finalization sends the terminal status ("succeeded") with zero customer prose.
    const finalized = await reportFinalizedRunDiagnostics(
      db,
      {
        id: run.id,
        companyId,
        agentId,
        status: "succeeded",
        driverKind: "codex",
        runtimeMode: "native",
        finishedAt: new Date("2026-11-25T15:00:00.000Z"),
      },
      { env, fetcher },
    );
    expect(finalized).toEqual(["git_storage_guard_unavailable", "github_capability_missing"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toBe("https://cloud.example.test/v1/customer-success/stack/diagnostics");
    expect(sent[1]!.headers["x-paperclip-cloud-tenant-host"]).toBe("tenant.example.test");
    expect(sent[1]!.body).toEqual({
      runId: run.id,
      diagnosticCodes: ["git_storage_guard_unavailable", "github_capability_missing"],
      runStatus: "succeeded",
      driverKind: "codex",
      runtimeMode: "native",
      occurredAt: "2026-11-25T15:00:00.000Z",
    });
  });

  it("persists distinct diagnostic codes recorded in separate calls without sequence collisions", async () => {
    const [run] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        driverKind: "codex",
      })
      .returning();

    const first = await recordRunPlatformDiagnostics(
      db,
      {
        companyId,
        runId: run.id,
        agentId,
        codes: ["github_capability_missing"],
      },
      { reportToCloud: false },
    );
    const second = await recordRunPlatformDiagnostics(
      db,
      {
        companyId,
        runId: run.id,
        agentId,
        codes: ["git_storage_guard_unavailable"],
      },
      { reportToCloud: false },
    );
    expect(first).toEqual(["github_capability_missing"]);
    expect(second).toEqual(["git_storage_guard_unavailable"]);

    const listed = await listRunPlatformDiagnostics(db, [run.id], companyId);
    expect(listed.get(run.id)).toEqual([
      "git_storage_guard_unavailable",
      "github_capability_missing",
    ]);
  });

  it("reloads missing error and metadata fields from heartbeat_runs during finalization", async () => {
    const [run] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "failed",
        exitCode: 1,
        runtimeMode: "legacy",
        driverKind: "claude",
        error: "remote_workspace_archive_failed: reason=git_storage_guard_unavailable",
        stderrExcerpt: "Paperclip: GitHub capability_rejected; token denied",
      })
      .returning();

    const sent: unknown[] = [];
    const fetcher: typeof fetch = vi.fn(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ recorded: 2 }), { status: 200 });
    });
    const env = {
      PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test",
      PAPERCLIP_PRIMARY_HOST: "tenant.example.test",
      [RUNTIME_DIAGNOSTICS_CAPABILITY_ENV]: "b".repeat(64),
    };

    // Pass only minimal fields — error/stderrExcerpt/driverKind/runtimeMode are omitted.
    const finalized = await reportFinalizedRunDiagnostics(
      db,
      {
        id: run.id,
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date("2026-11-25T16:00:00.000Z"),
      },
      { env, fetcher },
    );
    expect(finalized).toEqual(["git_storage_guard_unavailable", "github_capability_rejected"]);
    const listed = await listRunPlatformDiagnostics(db, [run.id], companyId);
    expect(listed.get(run.id)).toEqual([
      "git_storage_guard_unavailable",
      "github_capability_rejected",
    ]);
    expect(sent).toEqual([
      {
        runId: run.id,
        diagnosticCodes: ["git_storage_guard_unavailable", "github_capability_rejected"],
        runStatus: "failed",
        driverKind: "claude",
        runtimeMode: "legacy",
        occurredAt: "2026-11-25T16:00:00.000Z",
      },
    ]);
  });
});
