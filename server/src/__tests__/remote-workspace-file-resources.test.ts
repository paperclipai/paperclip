import express, { type Request } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecrets, companySecretBindings, createDb, environmentLeases, environments, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, plugins, secretAccessEvents, workspaceOperations, type Db } from "@paperclipai/db";
import { INSPECTION_AUDIENCE, INSPECTION_HEADER, INSPECTION_PERMIT_TYPE, parseInspectionQuery, type InspectionQuery, type InspectionPermit, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { fileResourceRoutes } from "../routes/file-resources.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { createRemoteWorkspaceFiles, REMOTE_WORKSPACE_FILES_SCRIPT } from "../services/remote-workspace-files.js";
import { workspaceFileResourceService } from "../services/workspace-file-resources.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { customerSuccessRoutes } from "../routes/customer-success.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { secretService } from "../services/secrets.js";
import { captureRemoteWorkspaceDirectory } from "../services/remote-workspace-snapshot-archive.js";
import { beginWorkspaceSnapshot, uploadWorkspaceSnapshot } from "../services/remote-workspace-snapshot-storage.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
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

  it("serves signed support reads from secret-bound live and saved workspaces inside its read-only transaction", async () => {
    const f = await fixture();
    const other = await fixture();
    const keyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "inspection-workspace-key-"));
    directories.push(keyDirectory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(keyDirectory, "master.key"));
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "remote-inspection-fixture");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN", "https://cloud.example.test");
    const keys = generateKeyPairSync("ed25519");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS", JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "cloud" }] }));
    const consumed = vi.fn(async () => Response.json({ consumed: true }));
    vi.stubGlobal("fetch", consumed);
    try {
      const pluginId = randomUUID();
      const provider = `inspection-${pluginId}`;
      const pluginKey = `paperclip.${provider}`;
      await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: `@paperclipai/${provider}`, version: "1.0.0", apiVersion: 1,
        categories: ["automation"], status: "ready", manifestJson: {
          id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Inspection fixture", description: "Synthetic inspection provider", author: "Paperclip",
          categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Inspection fixture",
            configSchema: { type: "object", properties: { apiKey: { type: "string", format: "secret-ref" } } } }],
        } });
      const secret = await secretService(db).create(f.ids.company, { name: "synthetic inspection provider", provider: "local_encrypted", value: "synthetic-provider-credential" });
      await secretService(db).createBinding({ companyId: f.ids.company, secretId: secret.id,
        targetType: "environment", targetId: f.ids.environment, configPath: "apiKey" });
      await db.update(environments).set({ config: { provider, apiKey: secret.id } }).where(eq(environments.id, f.ids.environment));
      await db.update(environmentLeases).set({ provider, metadata: { remoteCwd: f.root, provider, apiKey: secret.id,
        pluginId, sandboxProviderPlugin: true } }).where(eq(environmentLeases.id, f.ids.lease));

      const storage = createStorageService(createLocalDiskStorageProvider(path.join(keyDirectory, "objects")));
      const archivePath = path.join(keyDirectory, "saved.pcws");
      const archive = await captureRemoteWorkspaceDirectory({ cwd: f.root, archivePath });
      const [operation] = await db.insert(workspaceOperations).values({ companyId: f.ids.company,
        executionWorkspaceId: f.ids.workspace, phase: "synthetic_saved_fixture" }).returning();
      const snapshot = await beginWorkspaceSnapshot(db, { companyId: f.ids.company, workspaceId: f.ids.workspace,
        operationId: operation.id, generation: 1, epoch: 1 });
      await uploadWorkspaceSnapshot({ db, storage, companyId: f.ids.company, workspaceId: f.ids.workspace,
        snapshotId: snapshot.id, archivePath, manifestDigest: archive.manifestDigest });
      await db.update(executionWorkspaceSnapshots).set({ status: "committed" }).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      await fs.writeFile(path.join(f.root, "docs", "result.md"), "Updated live result\n");
      await fs.symlink(other.root, path.join(f.root, "escape"));

      const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(_pluginId).toBe(pluginId);
        expect(params.companyId).toBe(f.ids.company);
        expect(params.lease.providerLeaseId).toBe(f.authority.location!.providerLeaseId);
        expect(params.config.apiKey).toBe("synthetic-provider-credential");
        if (method === "environmentExecute") {
          expect(params.bypassSession).toBe(true);
          try {
            const result = await execFileAsync(process.execPath, params.args, { cwd: params.cwd, maxBuffer: 2 * 1024 * 1024 });
            return { ...result, exitCode: 0, timedOut: false, signal: null };
          } catch (error) {
            const result = error as { stdout: string; stderr: string };
            return { stdout: result.stdout, stderr: result.stderr, exitCode: 1, timedOut: false, signal: null };
          }
        }
        if (method === "environmentSyncOut") {
          for (const operation of params.operations) for (const mapping of operation.files) await fs.copyFile(mapping.sourcePath, mapping.targetPath);
          return { operations: [] };
        }
        throw new Error(`Inspection must not allocate or resume: ${method}`);
      });
      const workerManager = { call, isRunning: (id: string) => id === pluginId } as unknown as PluginWorkerManager;
      const app = express();
      app.use(express.json());
      app.use("/api/customer-success/v1", customerSuccessRoutes(db, storage, { pluginWorkerManager: workerManager }));
      app.use(errorHandler);
      const inspect = (value: InspectionQuery) => {
        const query = parseInspectionQuery(value);
        const now = Math.floor(Date.now() / 1000);
        const claims: InspectionPermit = { v: 1, iss: "paperclip-cloud", aud: INSPECTION_AUDIENCE, sub: "remote-inspection-fixture",
          iat: now, exp: now + 60, jti: randomUUID(), bindingVersion: 1, grantId: randomUUID(), requestId: randomUUID(),
          agentId: randomUUID(), keyId: "sha256:synthetic-fixture", runId: randomUUID(), query };
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: INSPECTION_PERMIT_TYPE, kid: "cloud" })).toString("base64url");
        const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const payload = `${header}.${body}`;
        return request(app).post("/api/customer-success/v1/read").set(INSPECTION_HEADER,
          `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`).send(query);
      };
      const base = { companyId: f.ids.company, resourceId: f.ids.issue, context: { workspace: "execution" as const } };
      const beforeSecret = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
      const beforeAudit = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.ids.company));
      const transaction = db.transaction.bind(db);
      const transactions: string[] = [];
      const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => transaction(async tx => {
        const [row] = await tx.execute(sql`show transaction_read_only`);
        transactions.push(String(row.transaction_read_only));
        return callback(tx);
      }, options)) as typeof db.transaction);
      // A reader accidentally closed over the outer Db fails here; nested
      // provider/config/secret reads must use the inspection transaction.
      const selectSpy = vi.spyOn(db, "select").mockImplementation(() => { throw new Error("Inspection escaped its transaction"); });
      try {
        const listed = await inspect({ ...base, operation: "files.list" }).expect(200);
        expect(listed.body).toMatchObject({ state: "available", workspace: { source: { kind: "live" } } });
        expect(JSON.stringify(listed.body)).not.toContain(".env");
        const read = await inspect({ ...base, operation: "files.read", path: "docs/result.md" }).expect(200);
        expect(read.body.content.data).toBe("Updated live result\n");
        const downloaded = await inspect({ ...base, operation: "files.download", path: "docs/result.md", range: { start: 2, end: 7 } }).expect(200);
        expect(Buffer.from(downloaded.body.content, "base64").toString()).toBe("dated ");
        expect(JSON.stringify([listed.body, read.body, downloaded.body])).not.toContain("synthetic-provider-credential");
        const beforeDenied = call.mock.calls.length;
        await inspect({ ...base, companyId: other.ids.company, operation: "files.read", path: "docs/result.md" }).expect(404);
        await inspect({ ...base, operation: "files.read", path: ".env" }).expect(403);
        await inspect({ ...base, context: { workspace: "execution", workspaceId: other.ids.workspace }, operation: "files.read", path: "docs/result.md" }).expect(422);
        expect(call).toHaveBeenCalledTimes(beforeDenied);
        await inspect({ ...base, operation: "files.read", path: "escape/docs/result.md" }).expect(403);
      } finally { selectSpy.mockRestore(); transactionSpy.mockRestore(); }
      expect(transactions.length).toBeGreaterThan(0);
      expect(new Set(transactions)).toEqual(new Set(["on"]));
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual(beforeSecret);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.ids.company))).toEqual(beforeAudit);

      await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, secret.id));
      const beforeUnbound = call.mock.calls.length;
      await inspect({ ...base, operation: "files.read", path: "docs/result.md" }).expect(422);
      expect(call).toHaveBeenCalledTimes(beforeUnbound);
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: null, snapshotId: snapshot.id } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      call.mockClear();
      const savedList = await inspect({ ...base, operation: "files.list" }).expect(200);
      expect(savedList.body).toMatchObject({ workspace: { source: { kind: "saved", snapshotId: snapshot.id } } });
      const savedRead = await inspect({ ...base, operation: "files.read", path: "docs/result.md" }).expect(200);
      expect(savedRead.body.content.data).toBe("Remote useful result\n");
      const savedDownload = await inspect({ ...base, operation: "files.download", path: "docs/result.md" }).expect(200);
      expect(Buffer.from(savedDownload.body.content, "base64").toString()).toBe("Remote useful result\n");
      expect(call).not.toHaveBeenCalled();
      expect(consumed).toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
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

  it.each(["confirmed_stop", "unknown_stop", "dirty", "foreign_receipt"])(
    "uses saved bytes only for a clean workspace with an exact stopped receipt (%s)", async state => {
      const f = await fixture();
      const snapshotId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: f.ids.company, name: "Stopped workspace reader" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.ids.company, agentId, status: "succeeded" });
      const termination = remoteTerminationReceipt({ id: f.ids.lease, companyId: f.ids.company, heartbeatRunId: runId,
        provider: "fake", providerLeaseId: f.authority.location!.providerLeaseId },
      { state: "stopped", providerLeaseId: f.authority.location!.providerLeaseId })!;
      await db.update(environmentLeases).set({ heartbeatRunId: runId, status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteCwd: f.root, ...(state !== "unknown_stop" ? { remoteExecutionTermination:
          state === "foreign_receipt" ? { ...termination, leaseId: randomUUID() } : termination } : {}) } })
        .where(eq(environmentLeases.id, f.ids.lease));
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, snapshotId, dirty: state === "dirty" } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      const savedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stopped-workspace-saved-"));
      directories.push(savedRoot);
      await fs.mkdir(path.join(savedRoot, "docs"));
      await fs.writeFile(path.join(savedRoot, "docs", "result.md"), "Saved stopped result\n");
      const cleanup = vi.fn(async () => {});
      const loadSavedWorkspace = vi.fn(async () => ({ root: savedRoot, savedAt: "2026-10-30T12:00:00.000Z", cleanup }));
      const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace });
      const content = workspaceFileResourceService(db, undefined, { remoteFiles }).readContent(f.ids.issue,
        { workspace: "execution", path: "docs/result.md" });
      if (state === "confirmed_stop") {
        await expect(content).resolves.toMatchObject({ content: { data: "Saved stopped result\n" },
          resource: { source: { kind: "saved", snapshotId, savedAt: "2026-10-30T12:00:00.000Z" } } });
        expect(loadSavedWorkspace).toHaveBeenCalledWith({ companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId });
        expect(cleanup).toHaveBeenCalledOnce();
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.ids.workspace));
        expect(workspace!.metadata?.remoteWorkspace).toMatchObject({ location: f.authority.location });
      } else {
        await expect(content).rejects.toMatchObject({ status: 422, details: { code: "workspace_unavailable" } });
        expect(loadSavedWorkspace).not.toHaveBeenCalled();
      }
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.syncOut).not.toHaveBeenCalled();
    },
  );

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
