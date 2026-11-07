import { describe, expect, it, vi } from "vitest";
import { assertOnlineMigrationManifest, assertOnlineMigrationRuntime, assertOnlineMigrationSchema, onlineWorkspaceMigrationReceipt, parseOnlineWorkspaceMigrationRequest, runOnlineWorkspaceMigration } from "./online-workspace-migration.js";
import type { Db } from "@paperclipai/db";
import * as database from "@paperclipai/db";
import fs from "node:fs/promises";
import * as buildCommit from "../build-commit.js";
import type { StorageService } from "../storage/types.js";

vi.mock("../services/remote-workspace-migration.js", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const owners = { ...actual };
  owners.migrateRemoteWorkspaceCohort = undefined;
  return owners;
});

const request = () => ({
  schema: "paperclip.online-workspace-migration.v1",
  toolCommit: "a".repeat(40),
  toolRoot: "/private/reviewed-core",
  source: { commit: "b".repeat(40), deploymentId: "11111111-1111-4111-8111-111111111111" },
  companyId: "22222222-2222-4222-8222-222222222222",
  workspaceIds: ["33333333-3333-4333-8333-333333333333"],
  mode: "single",
  deadlineMs: 720_000,
  concurrency: 1,
});

describe("online workspace migration request", () => {
  it("keeps the reviewed tool and serving source as separate identities", () => {
    const parsed = parseOnlineWorkspaceMigrationRequest(request());
    expect(parsed.toolCommit).not.toBe(parsed.source.commit);
    expect(parsed.mode).toBe("single");
  });

  it.each([
    { deadlineMs: 720_001 }, { concurrency: 9 }, { toolRoot: "/app" }, { toolRoot: "/app/override" },
    { toolRoot: "/" }, { toolRoot: "relative" }, { toolCommit: "head" }, { writersStopped: true },
    { mode: "resume" }, { operationId: "44444444-4444-4444-8444-444444444444" },
  ])("refuses unbounded or undeclared requests %j", delta => {
    expect(() => parseOnlineWorkspaceMigrationRequest({ ...request(), ...delta })).toThrow();
  });

  it("requires a single exact journal and snapshot for resume", () => {
    const resume = { ...request(), mode: "resume", operationId: "44444444-4444-4444-8444-444444444444",
      snapshotId: "55555555-5555-4555-8555-555555555555" };
    expect(parseOnlineWorkspaceMigrationRequest(resume).operationId).toBe(resume.operationId);
    expect(() => parseOnlineWorkspaceMigrationRequest({ ...resume, workspaceIds: [...resume.workspaceIds,
      "66666666-6666-4666-8666-666666666666"] })).toThrow("online_migration_single_workspace_required");
    expect(() => parseOnlineWorkspaceMigrationRequest({ ...resume, concurrency: 2 })).toThrow();
  });

  it("refuses duplicate membership and bounds the exact cohort", () => {
    const cohort = { ...request(), mode: "cohort", concurrency: 2 };
    expect(() => parseOnlineWorkspaceMigrationRequest({ ...cohort, workspaceIds: [cohort.workspaceIds[0], cohort.workspaceIds[0]] })).toThrow();
    expect(() => parseOnlineWorkspaceMigrationRequest({ ...cohort, workspaceIds: Array(9).fill(cohort.workspaceIds[0]) })).toThrow();
  });
});

describe("online workspace migration schema", () => {
  it.each([{ rows: [] }, { rows: [{ type: "integer", not_null: false }] }, { rows: [{ type: "text", not_null: true }] }])(
    "refuses missing or incompatible controller identity before accessing storage or owners", async ({ rows }) => {
      const execute = vi.fn().mockResolvedValue(rows);
      const storage = new Proxy({}, { get() { throw new Error("storage_must_not_be_used"); } }) as StorageService;
      await expect(runOnlineWorkspaceMigration({ db: { execute } as unknown as Db, storage,
        request: parseOnlineWorkspaceMigrationRequest(request()), signal: new AbortController().signal }))
        .rejects.toThrow("online_migration_schema_incompatible");
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts the exact additive nullable text column without applying schema", async () => {
    const execute = vi.fn().mockResolvedValue([{ attname: "controller_host_hash", type: "text", not_null: false }]);
    await expect(assertOnlineMigrationSchema({ execute } as unknown as Db)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before the first query", async () => {
    const execute = vi.fn();
    const abort = new AbortController(); abort.abort(new Error("fixture_cancelled"));
    await expect(runOnlineWorkspaceMigration({ db: { execute } as unknown as Db, storage: {} as StorageService,
      request: parseOnlineWorkspaceMigrationRequest(request()), signal: abort.signal })).rejects.toThrow("fixture_cancelled");
    expect(execute).not.toHaveBeenCalled();
  });
});


describe("online migration manifest and output", () => {
  it("requires the whole tool migration manifest without applying schema", async () => {
    const inspect = vi.spyOn(database, "inspectMigrations").mockResolvedValue({ status: "needsMigrations", tableCount: 1,
      availableMigrations: ["next.sql"], appliedMigrations: [], pendingMigrations: ["next.sql"], journalEntryCount: 0, reason: "pending-migrations" });
    try {
      await expect(assertOnlineMigrationManifest("postgres://fixture")).rejects.toThrow("online_migration_schema_manifest_pending");
      inspect.mockResolvedValue({ status: "upToDate", tableCount: 1, availableMigrations: [], appliedMigrations: [], journalEntryCount: 0 });
      await expect(assertOnlineMigrationManifest("postgres://fixture")).resolves.toBeUndefined();
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally { inspect.mockRestore(); }
  });

  it("reports authority IDs and a source digest without paths, credentials or repository URLs", () => {
    const receipt = onlineWorkspaceMigrationReceipt({ companyId: request().companyId, workspaceId: request().workspaceIds[0],
      snapshotId: "55555555-5555-4555-8555-555555555555", applied: true, replayed: false,
      localPath: "/private/user-files", source: { kind: "git", repoUrl: "https://private-token@example.test/repo" } });
    expect(receipt.members?.[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("private-token");
    expect(JSON.stringify(receipt)).not.toContain("user-files");
    const preflight = onlineWorkspaceMigrationReceipt({ companyId: request().companyId, cohortId: "not-an-apply-token",
      applied: false, eligible: true, workspaceIds: request().workspaceIds });
    expect(preflight).toMatchObject({ eligible: true, noAdmissionProof: true, workspaceIds: request().workspaceIds });
    expect(preflight.cohortId).toBeUndefined();
    expect(preflight.members).toBeUndefined();
  });
});


describe("separate online tool identity", () => {
  it("uses its own release stamp and exact tool root while checking the old serving source separately", async () => {
    const parsed = parseOnlineWorkspaceMigrationRequest(request());
    const originalNode = process.versions.node;
    Object.defineProperty(process.versions, "node", { value: "24.22.2", configurable: true });
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", parsed.source.deploymentId);
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", parsed.source.commit);
    vi.stubEnv("PORT", "3100");
    const realpath = vi.spyOn(fs, "realpath").mockImplementation(async value => value === parsed.toolRoot
      ? parsed.toolRoot : parsed.toolRoot + "/server/src/maintenance/online-workspace-migration.ts");
    const stamp = vi.spyOn(buildCommit, "readBuildCommit").mockReturnValue(parsed.toolCommit);
    const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ status: "ok", commit: parsed.source.commit }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(assertOnlineMigrationRuntime(parsed)).resolves.toBeUndefined();
      expect(stamp).toHaveBeenCalledWith(expect.objectContaining({ environmentCommit: null,
        buildInfoPath: parsed.toolRoot + "/server/dist/build-info.json" }));
      expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:3100/api/health");
      stamp.mockReturnValue(parsed.source.commit);
      await expect(assertOnlineMigrationRuntime(parsed)).rejects.toThrow("online_migration_tool_commit_mismatch");
      stamp.mockReturnValue(parsed.toolCommit);
      vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "77777777-7777-4777-8777-777777777777");
      await expect(assertOnlineMigrationRuntime(parsed)).rejects.toThrow("online_migration_source_deployment_changed");
      realpath.mockResolvedValue("/app/server/src/maintenance/online-workspace-migration.ts");
      await expect(assertOnlineMigrationRuntime(parsed)).rejects.toThrow("online_migration_tool_root_mismatch");
    } finally {
      Object.defineProperty(process.versions, "node", { value: originalNode, configurable: true });
      realpath.mockRestore(); stamp.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });
});


describe("optional cohort capability", () => {
  it.each(["cohort", "inspect"])("refuses %s for multiple members when the reviewed artifact has no cohort owner", async mode => {
    const execute = vi.fn().mockResolvedValue([{ type: "text", not_null: false }]);
    const parsed = parseOnlineWorkspaceMigrationRequest({ ...request(), mode, concurrency: 2,
      workspaceIds: [...request().workspaceIds, "66666666-6666-4666-8666-666666666666"] });
    await expect(runOnlineWorkspaceMigration({ db: { execute } as unknown as Db,
      storage: { provider: "s3" } as StorageService, request: parsed, signal: new AbortController().signal }))
      .rejects.toThrow("online_migration_cohort_unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
