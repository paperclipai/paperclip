import express, { type Request } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, environmentLeases, environments, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import type { RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { fileResourceRoutes } from "../routes/file-resources.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { createRemoteWorkspaceFiles, REMOTE_WORKSPACE_FILES_SCRIPT } from "../services/remote-workspace-files.js";
import { workspaceFileResourceService } from "../services/workspace-file-resources.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const externalDatabase = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalDatabase ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describe("confined workspace file helper", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-helper-")));
    await fs.mkdir(path.join(root, "folder"));
    await fs.writeFile(path.join(root, "folder", "report.md"), "Saved result\n");
    await fs.writeFile(path.join(root, ".env"), "hidden");
    await fs.symlink(os.tmpdir(), path.join(root, "escape"));
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function helper(action: string, args: Record<string, unknown>) {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=commonjs", "-e", REMOTE_WORKSPACE_FILES_SCRIPT,
      JSON.stringify({ root, action, ...args })], { maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  }

  it("lists ordinary children without exposing secrets or symlinks", async () => {
    const result = await helper("list", { options: { mode: "all", limit: 25, offset: 0, maxScannedEntries: 5000, maxDepth: 20 } });
    expect(result.entries.map((entry: { relativePath: string }) => entry.relativePath)).toEqual(["folder", "binary.bin"]);
    expect(result.truncated).toBe(false);
    const report = await helper("stat", { relativePath: "folder/report.md", withHash: true });
    expect(report).toMatchObject({ kind: "file", byteSize: 13, text: true });
    expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await helper("stat", { relativePath: "binary.bin" })).toMatchObject({ text: false });
  });

  it.each(["../outside", "/etc/passwd", "escape/file", ".env", "folder/../.env", "file:///etc/passwd", "folder\\report.md"])(
    "rejects a confined or policy-denied path %s", async relativePath => {
      await expect(helper("stat", { relativePath })).rejects.toThrow();
    },
  );

  it("uses bounded recursive search and pagination", async () => {
    const result = await helper("list", { options: { mode: "all", query: "report", limit: 1, offset: 0, maxScannedEntries: 5000, maxDepth: 20 } });
    expect(result.entries.map((entry: { relativePath: string }) => entry.relativePath)).toEqual(["folder/report.md"]);
    const bounded = await helper("list", { options: { mode: "recent", limit: 25, offset: 0, maxScannedEntries: 1, maxDepth: 20 } });
    expect(bounded.scannedCount).toBe(1);
    expect(bounded.truncated).toBe(true);
  });

  it("gets changed files from the workspace repository without revealing Git metadata or secrets", async () => {
    await execFileAsync("git", ["-C", root, "init", "--initial-branch=main"]);
    await execFileAsync("git", ["-C", root, "add", "folder/report.md"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
    await fs.writeFile(path.join(root, "folder", "report.md"), "Changed useful result\n");
    const result = await helper("list", { options: { mode: "changed", limit: 25, offset: 0, maxScannedEntries: 5000, maxDepth: 20 } });
    expect(result.entries.map((entry: { relativePath: string }) => entry.relativePath)).toEqual(["binary.bin", "folder/report.md"]);
  });
});

describeDatabase("remote workspace ordinary file routes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const directories: string[] = [];

  beforeAll(async () => {
    if (externalDatabase) db = createDb(externalDatabase);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("remote-workspace-files-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await temporary?.cleanup();
    await db?.$client.end();
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-file-test-")));
    directories.push(root);
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "result.md"), "Remote useful result\n");
    await fs.writeFile(path.join(root, ".env"), "private-key");
    const ids = { company: randomUUID(), workspace: randomUUID(), issue: randomUUID(), environment: randomUUID(), lease: randomUUID() };
    const authority: RemoteWorkspaceAuthority = {
      schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null, writerRunId: null, dirty: false,
      source: { kind: "empty" }, location: { environmentId: ids.environment, leaseId: ids.lease,
        providerLeaseId: `allocation-${ids.lease}`, remoteCwd: root },
    };
    await db.insert(companies).values({ id: ids.company, name: "File access", issuePrefix: `RF${ids.company.slice(0, 6)}` });
    await db.insert(executionWorkspaces).values({ id: ids.workspace, companyId: ids.company, mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "cloud_sandbox", name: "Remote task", metadata: { remoteWorkspace: authority } });
    await db.insert(issues).values({ id: ids.issue, companyId: ids.company, title: "Read remote result", executionWorkspaceId: ids.workspace });
    await db.update(executionWorkspaces).set({ sourceIssueId: ids.issue }).where(eq(executionWorkspaces.id, ids.workspace));
    await db.insert(environments).values({ id: ids.environment, name: `Remote file ${ids.environment}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: ids.lease, companyId: ids.company, environmentId: ids.environment,
      executionWorkspaceId: ids.workspace, issueId: ids.issue, provider: "fake", providerLeaseId: authority.location!.providerLeaseId,
      metadata: { remoteCwd: root } });
    let beforeCopy: (() => Promise<void>) | undefined;
    const execute = vi.fn(async (input: Parameters<EnvironmentRuntimeService["execute"]>[0]) => {
      expect(input.lease.id).toBe(ids.lease);
      expect(input.bypassSession).toBe(true);
      try {
        const output = await execFileAsync(process.execPath, input.args!, { cwd: input.cwd, maxBuffer: 2 * 1024 * 1024 });
        return { ...output, exitCode: 0, timedOut: false };
      } catch (error) {
        const failure = error as { stdout: string; stderr: string };
        return { stdout: failure.stdout, stderr: failure.stderr, exitCode: 1, timedOut: false };
      }
    });
    const syncOut = vi.fn(async (input: Parameters<EnvironmentRuntimeService["syncOut"]>[0]) => {
      await beforeCopy?.();
      for (const operation of input.operations) for (const mapping of operation.files) await fs.copyFile(mapping.sourcePath, mapping.targetPath);
      return { operations: input.operations.map(operation => ({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    });
    const runtime = { execute, syncOut } as unknown as Pick<EnvironmentRuntimeService, "execute" | "syncOut">;
    const remoteFiles = createRemoteWorkspaceFiles(db, { environmentRuntime: runtime });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [ids.company], source: "local_implicit", isInstanceAdmin: true } as Request["actor"];
      next();
    });
    app.use("/api", fileResourceRoutes(db, { remoteFiles }));
    app.use(errorHandler);
    return { root, ids, authority, execute, syncOut, remoteFiles, app, beforeCopy: (callback: () => Promise<void>) => { beforeCopy = callback; } };
  }

  it("lists, resolves, previews, and downloads live bytes without a controller checkout", async () => {
    const f = await fixture();
    const base = `/api/issues/${f.ids.issue}/file-resources`;
    const listed = await request(f.app).get(`${base}/list`).query({ workspace: "execution" }).expect(200);
    expect(listed.body).toMatchObject({ state: "available", workspace: { source: { kind: "live" } } });
    expect(listed.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(["docs"]);
    const resolved = await request(f.app).get(`${base}/resolve`).query({ path: "docs/result.md", workspace: "execution" }).expect(200);
    expect(resolved.body).toMatchObject({ kind: "file", source: { kind: "live" }, capabilities: { preview: true, download: true } });
    const preview = await request(f.app).get(`${base}/content`).query({ path: "docs/result.md", workspace: "execution" }).expect(200);
    expect(preview.body.content).toEqual({ encoding: "utf8", data: "Remote useful result\n" });
    const download = await request(f.app).get(`${base}/content`).query({ path: "docs/result.md", workspace: "execution", download: true }).expect(200);
    expect(download.text).toBe("Remote useful result\n");
    expect(f.syncOut).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(path.dirname(f.syncOut.mock.calls[0]![0].operations[0]!.files[0]!.targetPath)).catch(() => [])).toEqual([]);
  });

  it("rejects denied files before provider access and prevents changed transfer bytes", async () => {
    const f = await fixture();
    await request(f.app).get(`/api/issues/${f.ids.issue}/file-resources/content`).query({ workspace: "execution", path: ".env" }).expect(403);
    expect(f.execute).not.toHaveBeenCalled();
    f.beforeCopy(async () => { await fs.writeFile(path.join(f.root, "docs", "result.md"), "Another changed text\n"); });
    await expect(workspaceFileResourceService(db, undefined, { remoteFiles: f.remoteFiles }).readContent(f.ids.issue,
      { workspace: "execution", path: "docs/result.md" })).rejects.toMatchObject({ status: 422, details: { code: "file_changed" } });
  });

  it("reads saved content after explicit location release, with no provider call", async () => {
    const f = await fixture();
    const snapshotId = randomUUID();
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: null, snapshotId } } })
      .where(eq(executionWorkspaces.id, f.ids.workspace));
    const cleanup = vi.fn(async () => {});
    const loadSavedWorkspace = vi.fn(async () => ({ root: f.root, savedAt: "2026-10-30T12:00:00.000Z", cleanup }));
    const remoteFiles = createRemoteWorkspaceFiles(db, { environmentRuntime: { execute: f.execute, syncOut: f.syncOut } as unknown as Pick<EnvironmentRuntimeService, "execute" | "syncOut">, loadSavedWorkspace });
    const service = workspaceFileResourceService(db, undefined, { remoteFiles });
    const result = await service.readContent(f.ids.issue, { workspace: "execution", path: "docs/result.md" });
    expect(result).toMatchObject({ resource: { source: { kind: "saved", snapshotId, savedAt: "2026-10-30T12:00:00.000Z" } }, content: { data: "Remote useful result\n" } });
    expect(loadSavedWorkspace).toHaveBeenCalledWith({ companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.syncOut).not.toHaveBeenCalled();
  });

  it("does not fall back to a saved version for an unreachable live allocation", async () => {
    const f = await fixture();
    f.execute.mockRejectedValueOnce(new Error("provider unavailable"));
    const loadSavedWorkspace = vi.fn();
    const remoteFiles = createRemoteWorkspaceFiles(db, { environmentRuntime: { execute: f.execute, syncOut: f.syncOut } as unknown as Pick<EnvironmentRuntimeService, "execute" | "syncOut">, loadSavedWorkspace });
    await expect(workspaceFileResourceService(db, undefined, { remoteFiles }).resolve(f.ids.issue,
      { workspace: "execution", path: "docs/result.md" })).rejects.toMatchObject({ status: 422 });
    expect(loadSavedWorkspace).not.toHaveBeenCalled();
  });

  it("rejects cross-company and stale allocation bindings before provider access", async () => {
    const f = await fixture();
    await expect(f.remoteFiles.open({ companyId: randomUUID(), workspaceId: f.ids.workspace })).rejects.toMatchObject({ status: 404 });
    await db.update(environmentLeases).set({ providerLeaseId: "replacement" }).where(and(eq(environmentLeases.id, f.ids.lease), eq(environmentLeases.companyId, f.ids.company)));
    await expect(f.remoteFiles.open({ companyId: f.ids.company, workspaceId: f.ids.workspace })).rejects.toMatchObject({ status: 422 });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects a result after the durable workspace location changes", async () => {
    const f = await fixture();
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(async input => {
      const result = await original(input);
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, epoch: 2 } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      return result;
    });
    await expect(workspaceFileResourceService(db, undefined, { remoteFiles: f.remoteFiles }).resolve(f.ids.issue,
      { workspace: "execution", path: "docs/result.md" })).rejects.toMatchObject({ details: { code: "workspace_changed" } });
  });

  it("rejects corrupt provider metadata without exposing its output", async () => {
    const f = await fixture();
    f.execute.mockResolvedValueOnce({ stdout: '{"kind":"file","relativePath":"../../private","byteSize":1}',
      stderr: "private-provider-details", exitCode: 0, timedOut: false });
    await expect(workspaceFileResourceService(db, undefined, { remoteFiles: f.remoteFiles }).resolve(f.ids.issue,
      { workspace: "execution", path: "docs/result.md" })).rejects.toMatchObject({ message: "Workspace files are unavailable", details: { code: "workspace_unavailable" } });
  });
});
