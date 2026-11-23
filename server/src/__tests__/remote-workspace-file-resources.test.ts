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
import { agents, companies, companySecrets, companySecretBindings, createDb, environmentLeases, environments, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, plugins, projects, projectWorkspaces, secretAccessEvents, workspaceOperations, type Db } from "@paperclipai/db";
import { INSPECTION_AUDIENCE, INSPECTION_HEADER, INSPECTION_PERMIT_TYPE, parseInspectionQuery, type InspectionQuery, type InspectionPermit, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { notFound, unprocessable } from "../errors.js";
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
import { createSavedWorkspaceLoader } from "../services/remote-workspaces.js";
import { createSavedWorkspaceArchiveOpener } from "../services/saved-workspace-archive.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const decryptCleanupFault = vi.hoisted(() => ({ error: undefined as Error | undefined, path: undefined as string | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, async rm(target: Parameters<typeof actual.rm>[0], options: Parameters<typeof actual.rm>[1]) {
    if (decryptCleanupFault.error && String(target).includes("pc-workspace-decrypt-")) {
      const error = decryptCleanupFault.error; decryptCleanupFault.error = undefined; decryptCleanupFault.path = String(target); throw error;
    }
    return actual.rm(target, options);
  } };
});
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
    const app = filesApp(ids.company, remoteFiles);
    return { root, ids, authority, execute, syncOut, remoteFiles, app, beforeCopy: (callback: () => Promise<void>) => { beforeCopy = callback; } };
  }

  function filesApp(companyId: string, remoteFiles: ReturnType<typeof createRemoteWorkspaceFiles>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true } as Request["actor"];
      next();
    });
    app.use("/api", fileResourceRoutes(db, { remoteFiles }));
    app.use(errorHandler);
    return app;
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

  async function savedFileFixture(keepLocation = false, populate?: (root: string) => Promise<void>) {
    const f = await fixture(), storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saved-file-budget-"));
    await populate?.(f.root);
    directories.push(storageRoot);
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(storageRoot, "objects")));
    const archivePath = path.join(storageRoot, "saved.pcws"), archive = await captureRemoteWorkspaceDirectory({ cwd: f.root, archivePath });
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.ids.company,
      executionWorkspaceId: f.ids.workspace, phase: "synthetic_file_budget" }).returning();
    const snapshot = await beginWorkspaceSnapshot(db, { companyId: f.ids.company, workspaceId: f.ids.workspace,
      operationId: operation!.id, generation: 1, epoch: 1 });
    const saved = await uploadWorkspaceSnapshot({ db, storage, companyId: f.ids.company, workspaceId: f.ids.workspace,
      snapshotId: snapshot.id, archivePath, manifestDigest: archive.manifestDigest });
    await db.update(executionWorkspaceSnapshots).set({ status: "committed" }).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: keepLocation ? f.authority.location : null, snapshotId: snapshot.id } } })
      .where(eq(executionWorkspaces.id, f.ids.workspace));
    return { ...f, storage, saved, input: { companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId: snapshot.id } };
  }

  const richWorkspace = async (root: string) => {
    await fs.mkdir(path.join(root, "docs", "deep", "deeper"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "docs", "deep", "notes.txt"), "nested notes\n");
    await fs.writeFile(path.join(root, "docs", "deep", "deeper", "leaf.md"), "leaf\n");
    await fs.writeFile(path.join(root, "docs", "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
    await fs.writeFile(path.join(root, "docs", "big.bin"), Buffer.alloc(256 * 1024, 7));
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(root, "server.key"), "secret");
    for (let index = 0; index < 12; index++) await fs.writeFile(path.join(root, "src", `file-${index}.ts`), `export const v${index} = ${index};\n`);
    await fs.symlink("result.md", path.join(root, "docs", "link.md"));
  };

  it("reads a saved workspace above the extraction cap in place, one verified file at a time", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const capped = createSavedWorkspaceLoader(db, f.storage, { limits: { maxArchiveBytes: 1024 } });
    const base = `/api/issues/${f.ids.issue}/file-resources`;
    const extractOnly = filesApp(f.ids.company, createRemoteWorkspaceFiles(db, { loadSavedWorkspace: capped }));
    const refused = await request(extractOnly).get(`${base}/content`).query({ workspace: "execution", path: "docs/result.md" }).expect(422);
    expect(refused.body.details.code).toBe("too_large");

    const getObject = f.storage.getObject.bind(f.storage), ranges: Array<{ start: number; end: number } | undefined> = [];
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => { ranges.push(args[2]?.range); return getObject(...args); });
    const tmpBefore = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("pc-workspace-files-")).length;
    const app = filesApp(f.ids.company, createRemoteWorkspaceFiles(db, { loadSavedWorkspace: capped,
      openSavedWorkspaceArchive: createSavedWorkspaceArchiveOpener(db, f.storage) }));
    const preview = await request(app).get(`${base}/content`).query({ workspace: "execution", path: "docs/result.md" }).expect(200);
    expect(preview.body).toMatchObject({ content: { data: "Remote useful result\n" }, resource: { source: { kind: "saved", snapshotId: f.saved.id } } });
    const listed = await request(app).get(`${base}/list`).query({ workspace: "execution", path: "docs" }).expect(200);
    expect(listed.body.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(expect.arrayContaining(["docs/big.bin", "docs/result.md"]));
    const download = await request(app).get(`${base}/content`).query({ workspace: "execution", path: "docs/big.bin", download: true })
      .buffer(true).parse((response, done) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(Buffer.compare(download.body as Buffer, Buffer.alloc(256 * 1024, 7))).toBe(0);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(range => range !== undefined)).toBe(true);
    const fetched = ranges.reduce((total, range) => total + range!.end - range!.start + 1, 0);
    expect(fetched).toBeLessThan(f.saved.byteSize + 64 * 1024);
    expect((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("pc-workspace-files-")).length).toBe(tmpBefore);
  });

  it("answers saved stat and list exactly like the extracted helper", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const extracted = createRemoteWorkspaceFiles(db, { loadSavedWorkspace: createSavedWorkspaceLoader(db, f.storage) });
    const archived = createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: createSavedWorkspaceArchiveOpener(db, f.storage) });
    const scope = { companyId: f.ids.company, workspaceId: f.ids.workspace };
    const outcome = async (work: () => Promise<unknown>) => {
      try {
        const value = JSON.parse(JSON.stringify(await work()));
        const strip = (entry: Record<string, unknown>) => { delete entry.modifiedAt; return entry; };
        if (Array.isArray(value?.entries)) value.entries.forEach(strip); else if (value && typeof value === "object") strip(value);
        return { value };
      } catch (error) { return { status: (error as { status?: number }).status, code: (error as { details?: { code?: string } }).details?.code }; }
    };
    const [left, right] = [await extracted.open(scope), await archived.open(scope)];
    try {
      for (const relative of ["docs/result.md", "docs", "docs/binary.bin", "docs/big.bin", "docs/deep/deeper/leaf.md", "missing.md",
        "docs/result.md/inner", "docs/link.md", ".env", "server.key", "node_modules/pkg/index.js", "../outside", "docs//x"]) {
        expect(await outcome(() => right!.stat(relative)), relative).toEqual(await outcome(() => left!.stat(relative)));
      }
      const lists = [
        { mode: "all", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", relativePath: "docs", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", relativePath: "src", limit: 5, offset: 3, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", query: "leaf", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", query: "file", limit: 100, offset: 0, maxScannedEntries: 7, maxDepth: 20 },
        { mode: "recent", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 1 },
        { mode: "recent", limit: 4, offset: 2, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", relativePath: "docs/result.md", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 },
        { mode: "all", relativePath: "node_modules", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 },
      ] as const;
      for (const list of lists) {
        const [expected, actual] = [await outcome(() => left!.list({ ...list })), await outcome(() => right!.list({ ...list }))];
        if (list.mode === "recent" && list.limit === 100) {
          const byPath = (value: { value?: { entries?: Array<{ relativePath: string }> } }) =>
            [...(value.value?.entries ?? [])].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
          expect(byPath(actual), JSON.stringify(list)).toEqual(byPath(expected));
          expect(byPath(actual).map(entry => entry.relativePath))
            .toEqual((actual.value as { entries: Array<{ relativePath: string }> }).entries.map(entry => entry.relativePath));
        } else if (list.mode !== "recent") {
          expect(actual, JSON.stringify(list)).toEqual(expected);
        }
      }
    } finally { await left?.close(); await right?.close(); }
  });

  it("refuses a saved file whose stored bytes no longer match its verified manifest", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const getObject = f.storage.getObject.bind(f.storage);
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      const object = await getObject(...args);
      if (!args[2]?.range || args[2].range.end - args[2].range.start < 1024) return object;
      const { Transform } = await import("node:stream");
      return { ...object, stream: object.stream.pipe(new Transform({ transform(bytes: Buffer, _encoding, callback) {
        const tampered = Buffer.from(bytes); tampered[0] ^= 0xff; callback(null, tampered);
      } })) };
    });
    const archived = createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: createSavedWorkspaceArchiveOpener(db, f.storage) });
    const access = await archived.open({ companyId: f.ids.company, workspaceId: f.ids.workspace });
    try {
      await expect(access!.download("docs/big.bin")).rejects.toMatchObject({ status: 422, details: { code: "file_changed" } });
    } finally { await access?.close(); }
  });

  it("keeps changed files on bounded extraction and names its limit for a saved workspace above the cap", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const opener = createSavedWorkspaceArchiveOpener(db, f.storage), scope = { companyId: f.ids.company, workspaceId: f.ids.workspace };
    const changed = { mode: "changed", limit: 100, offset: 0, maxScannedEntries: 5000, maxDepth: 20 } as const;
    const capped = createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: opener,
      loadSavedWorkspace: createSavedWorkspaceLoader(db, f.storage, { limits: { maxArchiveBytes: 1024 } }) });
    const cappedAccess = await capped.open(scope);
    try { await expect(cappedAccess!.list({ ...changed })).rejects.toMatchObject({ status: 422, details: { code: "changed_unavailable" } }); }
    finally { await cappedAccess?.close(); }
    const bounded = createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: opener, loadSavedWorkspace: createSavedWorkspaceLoader(db, f.storage) });
    const boundedAccess = await bounded.open(scope);
    try {
      await expect(boundedAccess!.list({ ...changed })).rejects.toMatchObject({ details: { code: "changed_unavailable" } });
      expect(await boundedAccess!.stat("docs/result.md")).toMatchObject({ kind: "file", byteSize: 21 });
    } finally { await boundedAccess?.close(); }
  });

  it("reserves bounded temporary disk for saved downloads and releases it after each one", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const scope = { companyId: f.ids.company, workspaceId: f.ids.workspace }, opener = createSavedWorkspaceArchiveOpener(db, f.storage);
    const files = (limits: NonNullable<Parameters<typeof createRemoteWorkspaceFiles>[1]>["savedFileDownloadLimits"]) =>
      createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: opener, savedFileDownloadLimits: limits });
    const attempt = async (limits: Parameters<typeof files>[0]) => {
      const access = await files(limits).open(scope);
      try {
        const download = await access!.download("docs/big.bin");
        let size = 0; for await (const chunk of download.stream) size += chunk.length; await download.cleanup();
        return size;
      } finally { await access?.close(); }
    };
    await expect(attempt({ maxReservedBytes: 1024 })).rejects.toMatchObject({ status: 422, details: { code: "too_large" } });
    await expect(attempt({ availableBytes: async () => 0n })).rejects.toMatchObject({ status: 422, details: { code: "workspace_unavailable" } });
    const fitsOne = { maxReservedBytes: 256 * 1024, freeSpaceMarginBytes: 0 };
    expect(await attempt(fitsOne)).toBe(256 * 1024);
    expect(await attempt(fitsOne)).toBe(256 * 1024);
    const access = await files(fitsOne).open(scope);
    try {
      const held = await access!.download("docs/big.bin");
      await expect(access!.download("docs/big.bin")).rejects.toMatchObject({ status: 422, details: { code: "workspace_unavailable" } });
      held.stream.destroy(); await held.cleanup();
    } finally { await access?.close(); }
    const preview = await (await files(fitsOne).open(scope))!.read("docs/result.md", { maxBytes: 1024 });
    expect(preview.toString()).toBe("Remote useful result\n");
    let freeSpaceChecked!: () => void;
    const checking = new Promise<void>(resolve => { freeSpaceChecked = resolve; });
    const slow = { ...fitsOne, availableBytes: async () => { await checking; return 1n << 40n; } };
    const [first, second] = [await files(slow).open(scope), await files(slow).open(scope)];
    try {
      const together = Promise.allSettled([first!.download("docs/big.bin"), second!.download("docs/big.bin")]);
      await new Promise(resolve => setTimeout(resolve, 50));
      freeSpaceChecked();
      const outcomes = await together;
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 422, details: { code: "workspace_unavailable" } } });
      for (const outcome of outcomes) if (outcome.status === "fulfilled") { outcome.value.stream.destroy(); await outcome.value.cleanup(); }
    } finally { await first?.close(); await second?.close(); }
  });

  it("closes the storage stream when a saved range read is abandoned or stalls", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const getObject = f.storage.getObject.bind(f.storage), sources: Array<import("node:stream").Readable> = [];
    let stall = false;
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      const object = await getObject(...args);
      if (stall && args[2]?.range && args[2].range.end - args[2].range.start > 1024) {
        object.stream.destroy();
        const { PassThrough } = await import("node:stream");
        const silent = new PassThrough();
        sources.push(silent);
        return { ...object, stream: silent };
      }
      sources.push(object.stream);
      return object;
    });
    const opener = createSavedWorkspaceArchiveOpener(db, f.storage, { idleTimeoutMs: 100 });
    const archive = await opener({ companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId: f.saved.id });
    try {
      const entry = archive.entry("docs/big.bin")!;
      const abandoned = await archive.read(entry, 0, entry.size);
      await new Promise(resolve => abandoned.once("readable", resolve));
      abandoned.destroy();
      await vi.waitFor(() => expect(sources.at(-1)!.destroyed).toBe(true));
      stall = true;
      const stalled = await archive.read(entry, 0, entry.size);
      await expect((async () => { for await (const chunk of stalled) void chunk; })()).rejects.toThrow("remote_workspace_snapshot_download_stalled");
      await vi.waitFor(() => expect(sources.at(-1)!.destroyed).toBe(true));
    } finally { archive.close(); }
  });

  it("charges one cached index for overlapping cold opens and names an oversized manifest", async () => {
    const f = await savedFileFixture(false, richWorkspace);
    const input = { companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId: f.saved.id };
    const single = createSavedWorkspaceArchiveOpener(db, f.storage);
    const once = await single(input); const charge = once.cachedIndexBytes(); once.close();
    const getObject = f.storage.getObject.bind(f.storage), manifestReads: unknown[] = [];
    const spy = vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      if (args[2]?.range?.start === 19) manifestReads.push(args[2].range);
      return getObject(...args);
    });
    const overlapping = createSavedWorkspaceArchiveOpener(db, f.storage);
    const opened = await Promise.all([overlapping(input), overlapping(input), overlapping(input)]);
    spy.mockRestore();
    expect(manifestReads).toHaveLength(2);
    expect(opened.map(archive => archive.cachedIndexBytes())).toEqual([charge, charge, charge]);
    for (const archive of opened) archive.close();
    const capped = createRemoteWorkspaceFiles(db, { openSavedWorkspaceArchive: createSavedWorkspaceArchiveOpener(db, f.storage, { maxIndexEntries: 3 }) });
    await expect(capped.open({ companyId: f.ids.company, workspaceId: f.ids.workspace }))
      .rejects.toMatchObject({ status: 422, details: { code: "too_large" } });
  });

  it("lets a cancelled saved open stop waiting for a busy manifest build", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = async () => {
      const f = await savedFileFixture(false);
      const getObject = f.storage.getObject.bind(f.storage);
      vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
        if (args[2]?.range?.start === 19) await gate;
        return getObject(...args);
      });
      const opener = createSavedWorkspaceArchiveOpener(db, f.storage);
      return { opener, input: { companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId: f.saved.id } };
    };
    const [first, second, third] = [await held(), await held(), await held()];
    const busy = [first.opener(first.input), second.opener(second.input)];
    await new Promise(resolve => setTimeout(resolve, 50));
    const queued = new AbortController(), sharing = new AbortController();
    const queuedOpen = third.opener({ ...third.input, signal: queued.signal });
    const sharedOpen = first.opener({ ...first.input, signal: sharing.signal });
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = performance.now();
    queued.abort(new Error("request closed")); sharing.abort(new Error("request closed"));
    await expect(queuedOpen).rejects.toThrow("request closed");
    await expect(sharedOpen).rejects.toThrow("request closed");
    expect(performance.now() - started).toBeLessThan(1000);
    release();
    for (const archive of await Promise.all(busy)) { expect(archive.entry("docs/result.md")).toBeDefined(); archive.close(); }
    const reopened = await third.opener(third.input);
    expect(reopened.entry("docs/result.md")).toBeDefined(); reopened.close();
  });

  it("retries a failed shared manifest build once for all of its waiters", async () => {
    const f = await savedFileFixture(false);
    const getObject = f.storage.getObject.bind(f.storage);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let manifestReads = 0, failed = false;
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      if (args[2]?.range?.start === 19) {
        manifestReads++;
        if (!failed) { failed = true; await gate; throw new Error("transient storage failure"); }
      }
      return getObject(...args);
    });
    const opener = createSavedWorkspaceArchiveOpener(db, f.storage);
    const input = { companyId: f.ids.company, workspaceId: f.ids.workspace, snapshotId: f.saved.id };
    const first = opener(input);
    await new Promise(resolve => setTimeout(resolve, 50));
    const waiters = [opener(input), opener(input), opener(input)];
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await expect(first).rejects.toThrow("transient storage failure");
    for (const archive of await Promise.all(waiters)) { expect(archive.entry("docs/result.md")).toBeDefined(); archive.close(); }
    expect(manifestReads).toBe(3);
  });

  it("keeps a production saved preview available when cleanup clears its location during archive loading", async () => {
    const f = await savedFileFixture(true);
    const requestTemp = await fs.mkdtemp(path.join(os.tmpdir(), "saved-file-location-request-"));
    directories.push(requestTemp);
    const { createApp } = await import("../app.js");
    const app = await createApp(db, { uiMode: "none", serverPort: 3100, storageService: f.storage,
      deploymentMode: "local_trusted", deploymentExposure: "public", bindHost: "127.0.0.1",
      allowedHostnames: ["127.0.0.1", "localhost"], authReady: false, companyDeletionEnabled: false,
      managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => null } });
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = requestTemp;
    let cleared = false;
    const getObject = f.storage.getObject.bind(f.storage);
    const retrieve = vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      const object = await getObject(...args);
      if (cleared) return object;
      cleared = true;
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
        ...f.authority, snapshotId: f.saved.id, location: null,
      } } }).where(eq(executionWorkspaces.id, f.ids.workspace));
      await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() })
        .where(eq(environmentLeases.id, f.ids.lease));
      return object;
    });
    try {
      await app.locals.bundledPluginsStartup;
      const response = await request(app).get(`/api/issues/${f.ids.issue}/file-resources/content`)
        .query({ workspace: "execution", path: "docs/result.md" });
      expect({ status: response.status, code: response.body.details?.code }).toEqual({ status: 200, code: undefined });
      expect(response.body).toMatchObject({ resource: { source: { kind: "saved", snapshotId: f.saved.id } },
        content: { encoding: "utf8", data: "Remote useful result\n" } });
      expect(retrieve).toHaveBeenCalled();
      expect(retrieve.mock.calls.every(call => call[2]?.range !== undefined)).toBe(true);
      expect(await fs.readdir(requestTemp)).toEqual([]);
    } finally {
      retrieve.mockRestore();
      try { await app.locals.paperclipShutdown(); }
      finally { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; }
    }
  }, 60_000);

  it("serves committed saved bytes through ordinary routes while the live allocation is unavailable", async () => {
    const f = await savedFileFixture(true);
    f.execute.mockRejectedValue(new Error("synthetic live allocation unavailable"));
    const load = createSavedWorkspaceLoader(db, f.storage), closed: Promise<void>[] = [];
    const loadSavedWorkspace = vi.fn(async (input: Parameters<typeof load>[0]) => {
      const saved = await load(input);
      let finish!: () => void, fail!: (error: unknown) => void;
      closed.push(new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
      return { ...saved, cleanup: async () => {
        try { await saved.cleanup(); finish(); } catch (error) { fail(error); throw error; }
      } };
    });
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace, environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const app = filesApp(f.ids.company, remoteFiles), base = `/api/issues/${f.ids.issue}/file-resources`;
    const preview = await request(app).get(`${base}/content`).query({ workspace: "execution", path: "docs/result.md" }).expect(200);
    expect(preview.body).toMatchObject({ content: { data: "Remote useful result\n" }, resource: { source: { kind: "saved", snapshotId: f.saved.id } } });
    const listed = await request(app).get(`${base}/list`).query({ workspace: "execution", path: "docs" }).expect(200);
    expect(listed.body).toMatchObject({ workspace: { source: { kind: "saved", snapshotId: f.saved.id } } });
    const resolved = await request(app).get(`${base}/resolve`).query({ workspace: "execution", path: "docs/result.md" }).expect(200);
    expect(resolved.body).toMatchObject({ source: { kind: "saved", snapshotId: f.saved.id }, capabilities: { preview: true, download: true } });
    const download = await request(app).get(`${base}/content`).query({ workspace: "execution", path: "docs/result.md", download: true }).expect(200);
    expect(download.text).toBe("Remote useful result\n");
    expect(f.execute).not.toHaveBeenCalled(); expect(f.syncOut).not.toHaveBeenCalled();
    expect(loadSavedWorkspace).toHaveBeenCalledTimes(4);
    // A streamed response can finish at the client before its server finally block.
    await Promise.all(closed);
    for (const loaded of loadSavedWorkspace.mock.results) await expect(fs.stat((await loaded.value).root)).rejects.toMatchObject({ code: "ENOENT" });
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.ids.workspace));
    expect(workspace!.metadata?.remoteWorkspace).toMatchObject({ location: f.authority.location, dirty: false, writerRunId: null });
  });

  it.each(["dirty", "writer"] as const)("keeps %s work on the live path and never substitutes its older save", async state => {
    const f = await savedFileFixture(true);
    let writerRunId: string | null = null;
    if (state === "writer") {
      const [agent] = await db.insert(agents).values({ companyId: f.ids.company, name: "Current workspace writer" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.ids.company, agentId: agent!.id, status: "running" }).returning();
      writerRunId = run!.id;
    }
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, snapshotId: f.saved.id, dirty: state === "dirty", writerRunId } } })
      .where(eq(executionWorkspaces.id, f.ids.workspace));
    await fs.writeFile(path.join(f.root, "docs", "result.md"), "Unsaved live result\n");
    const loadSavedWorkspace = vi.fn(createSavedWorkspaceLoader(db, f.storage));
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace, environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const app = filesApp(f.ids.company, remoteFiles), route = `/api/issues/${f.ids.issue}/file-resources/content`;
    const current = await request(app).get(route).query({ workspace: "execution", path: "docs/result.md" }).expect(200);
    expect(current.body).toMatchObject({ resource: { source: { kind: "live" } }, content: { data: "Unsaved live result\n" } });
    f.execute.mockRejectedValueOnce(new Error("synthetic live allocation unavailable"));
    const unavailable = await request(app).get(route).query({ workspace: "execution", path: "docs/result.md" }).expect(422);
    expect(unavailable.body).not.toHaveProperty("content"); expect(loadSavedWorkspace).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves the optional saved-loader boundary with a recorded location=%s", async keepLocation => {
    const f = await savedFileFixture(keepLocation);
    const remoteFiles = createRemoteWorkspaceFiles(db, { environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const response = await request(filesApp(f.ids.company, remoteFiles)).get(`/api/issues/${f.ids.issue}/file-resources/content`)
      .query({ workspace: "execution", path: "docs/result.md" }).expect(keepLocation ? 200 : 422);
    if (keepLocation) {
      expect(response.body).toMatchObject({ resource: { source: { kind: "live" } }, content: { data: "Remote useful result\n" } });
      expect(f.execute).toHaveBeenCalled();
    } else {
      expect(response.body).not.toHaveProperty("content"); expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it.each(["company", "workspace", "uncommitted"] as const)("rejects a saved snapshot with an invalid %s binding before object retrieval", async invalid => {
    const f = await savedFileFixture(true);
    if (invalid === "company") {
      const [other] = await db.insert(companies).values({ name: "Other saved-file company" }).returning();
      await db.update(executionWorkspaceSnapshots).set({ companyId: other!.id }).where(eq(executionWorkspaceSnapshots.id, f.saved.id));
    } else if (invalid === "workspace") {
      const [other] = await db.insert(executionWorkspaces).values({ companyId: f.ids.company, mode: "isolated_workspace",
        strategyType: "project_primary", providerType: "cloud_sandbox", name: "Other saved-file workspace" }).returning();
      await db.update(executionWorkspaceSnapshots).set({ executionWorkspaceId: other!.id }).where(eq(executionWorkspaceSnapshots.id, f.saved.id));
    } else await db.update(executionWorkspaceSnapshots).set({ status: "uploaded" }).where(eq(executionWorkspaceSnapshots.id, f.saved.id));
    const getObject = vi.spyOn(f.storage, "getObject");
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace: createSavedWorkspaceLoader(db, f.storage),
      environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const response = await request(filesApp(f.ids.company, remoteFiles)).get(`/api/issues/${f.ids.issue}/file-resources/content`)
      .query({ workspace: "execution", path: "docs/result.md" });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.body).not.toHaveProperty("content");
    expect(getObject).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.syncOut).not.toHaveBeenCalled();
    getObject.mockRestore();
  });

  it("fences a saved read if a new writer claims the workspace during extraction and removes its scratch files", async () => {
    const f = await savedFileFixture(true), load = createSavedWorkspaceLoader(db, f.storage);
    let savedRoot: string | undefined;
    const loadSavedWorkspace = async (input: Parameters<typeof load>[0]) => {
      const saved = await load(input); savedRoot = saved.root;
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, snapshotId: f.saved.id, dirty: true, epoch: 2 } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      return saved;
    };
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace, environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const response = await request(filesApp(f.ids.company, remoteFiles)).get(`/api/issues/${f.ids.issue}/file-resources/content`)
      .query({ workspace: "execution", path: "docs/result.md" }).expect(422);
    expect(response.body.details.code).toBe("workspace_changed"); expect(response.body).not.toHaveProperty("content");
    expect(savedRoot).toBeDefined(); await expect(fs.stat(savedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.syncOut).not.toHaveBeenCalled();
  });

  it.each(["epoch", "snapshot", "dirty", "writer", "source", "foreign_location"] as const)(
    "still fences a saved read when %s changes during extraction", async changed => {
      const f = await savedFileFixture(true), load = createSavedWorkspaceLoader(db, f.storage);
      let savedRoot: string | undefined;
      const loadSavedWorkspace = async (input: Parameters<typeof load>[0]) => {
        const saved = await load(input); savedRoot = saved.root;
        const next: RemoteWorkspaceAuthority = { ...f.authority, snapshotId: f.saved.id, location: null };
        if (changed === "epoch") next.epoch++;
        if (changed === "snapshot") next.snapshotId = randomUUID();
        if (changed === "dirty") next.dirty = true;
        if (changed === "writer") next.writerRunId = randomUUID();
        if (changed === "source") next.source = { kind: "git", repoUrl: "https://example.test/other.git", ref: null };
        if (changed === "foreign_location") next.location = { ...f.authority.location!, leaseId: randomUUID() };
        await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: next } }).where(eq(executionWorkspaces.id, f.ids.workspace));
        return saved;
      };
      const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace, environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
      const response = await request(filesApp(f.ids.company, remoteFiles)).get(`/api/issues/${f.ids.issue}/file-resources/content`)
        .query({ workspace: "execution", path: "docs/result.md" }).expect(422);
      expect(response.body.details.code).toBe("workspace_changed"); expect(response.body).not.toHaveProperty("content");
      expect(savedRoot).toBeDefined(); await expect(fs.stat(savedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.execute).not.toHaveBeenCalled(); expect(f.syncOut).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("rejects a location reappearing on an open saved copy (initial location=%s)", async keepLocation => {
    const f = await savedFileFixture(keepLocation);
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace: createSavedWorkspaceLoader(db, f.storage) });
    const access = await remoteFiles.open({ companyId: f.ids.company, workspaceId: f.ids.workspace });
    expect(access?.source.kind).toBe("saved");
    try {
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, snapshotId: f.saved.id, location: null } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      expect((await access!.stat("docs/result.md")).kind).toBe("file");
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, snapshotId: f.saved.id } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      await expect(access!.stat("docs/result.md")).rejects.toMatchObject({ status: 422, details: { code: "workspace_changed" } });
    } finally { await access?.close(); }
  });

  it("keeps a live read fenced when its physical location is cleared", async () => {
    const f = await savedFileFixture(true), live = { ...f.authority, snapshotId: f.saved.id, dirty: true };
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: live } }).where(eq(executionWorkspaces.id, f.ids.workspace));
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(async input => {
      const result = await execute(input);
      await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...live, location: null } } })
        .where(eq(executionWorkspaces.id, f.ids.workspace));
      return result;
    });
    const loadSavedWorkspace = vi.fn(createSavedWorkspaceLoader(db, f.storage));
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace, environmentRuntime: { execute: f.execute, syncOut: f.syncOut } });
    const response = await request(filesApp(f.ids.company, remoteFiles)).get(`/api/issues/${f.ids.issue}/file-resources/content`)
      .query({ workspace: "execution", path: "docs/result.md" }).expect(422);
    expect(response.body.details.code).toBe("workspace_changed"); expect(response.body).not.toHaveProperty("content");
    expect(f.execute).toHaveBeenCalledTimes(1); expect(loadSavedWorkspace).not.toHaveBeenCalled();
  });

  it("shares fail-fast saved Files admission across loader instances until owned cleanup completes", async () => {
    const f = await savedFileFixture(), availableBytes = async () => 8n * 1024n ** 3n;
    const first = createSavedWorkspaceLoader(db, f.storage, { availableBytes });
    const second = createSavedWorkspaceLoader(db, f.storage, { availableBytes });
    const third = createSavedWorkspaceLoader(db, f.storage, { availableBytes });
    const opened: Array<{ root: string; cleanup(): Promise<void> }> = [];
    const getObject = vi.spyOn(f.storage, "getObject");
    try {
      opened.push(await first(f.input)); opened.push(await second(f.input));
      expect(opened[0]!.root).not.toBe(opened[1]!.root);
      getObject.mockClear();
      await expect(third(f.input)).rejects.toMatchObject({ status: 422, details: { code: "workspace_unavailable" } });
      expect(getObject).not.toHaveBeenCalled();
      await opened[0]!.cleanup(); await opened[0]!.cleanup();
      await expect(fs.stat(opened[0]!.root)).rejects.toMatchObject({ code: "ENOENT" });
      opened.push(await third(f.input));
      expect(getObject).toHaveBeenCalledTimes(1);
    } finally { await Promise.all(opened.map(access => access.cleanup())); getObject.mockRestore(); }
  });

  it("bounds reserved scratch bytes across saved Files loader instances", async () => {
    const f = await savedFileFixture(), options = { availableBytes: async () => 8n * 1024n ** 3n,
      limits: { maxScratchBytes: 180 * 1024 * 1024 } };
    const first = createSavedWorkspaceLoader(db, f.storage, options), second = createSavedWorkspaceLoader(db, f.storage, options);
    const access = await first(f.input), getObject = vi.spyOn(f.storage, "getObject");
    try {
      await expect(second(f.input)).rejects.toMatchObject({ status: 422, details: { code: "workspace_unavailable" } });
      expect(getObject).not.toHaveBeenCalled();
    } finally { await access.cleanup(); getObject.mockRestore(); }
    const next = await second(f.input); await next.cleanup();
  });

  it.each(["archive", "disk"] as const)("rejects saved Files %s bounds before object retrieval and releases admission", async bound => {
    const f = await savedFileFixture(), getObject = vi.spyOn(f.storage, "getObject");
    if (bound === "archive") await db.update(executionWorkspaceSnapshots).set({ byteSize: 512 * 1024 * 1024 + 1 })
      .where(eq(executionWorkspaceSnapshots.id, f.saved.id));
    const load = createSavedWorkspaceLoader(db, f.storage, { availableBytes: async () => bound === "disk" ? 0n : 8n * 1024n ** 3n });
    try {
      await expect(load(f.input)).rejects.toMatchObject({ status: 422, details: { code: bound === "archive" ? "too_large" : "workspace_unavailable" } });
      expect(getObject).not.toHaveBeenCalled();
    } finally {
      await db.update(executionWorkspaceSnapshots).set({ byteSize: f.saved.byteSize }).where(eq(executionWorkspaceSnapshots.id, f.saved.id));
      getObject.mockRestore();
    }
    const next = await createSavedWorkspaceLoader(db, f.storage, { availableBytes: async () => 8n * 1024n ** 3n })(f.input);
    await next.cleanup();
  });

  it.each(["entries", "manifest"] as const)("rejects excessive saved Files %s before extraction and cleans the reserved archive", async bound => {
    const f = await savedFileFixture(), options = { availableBytes: async () => 8n * 1024n ** 3n };
    await expect(createSavedWorkspaceLoader(db, f.storage, { ...options, limits: bound === "entries" ? { maxEntries: 1 } : { maxManifestBytes: 1 } })(f.input))
      .rejects.toMatchObject({ status: 422, details: { code: "too_large" } });
    const opened: Array<{ root: string; cleanup(): Promise<void> }> = [];
    try {
      const load = createSavedWorkspaceLoader(db, f.storage, options);
      opened.push(await load(f.input)); opened.push(await load(f.input));
      expect(await fs.readFile(path.join(opened[0]!.root, "docs", "result.md"), "utf8")).toBe("Remote useful result\n");
    } finally { await Promise.all(opened.map(access => access.cleanup())); }
  });

  it("preserves object failures while releasing saved Files admission for the next copies", async () => {
    const f = await savedFileFixture(), original = new Error("synthetic object retrieval failed");
    const options = { availableBytes: async () => 8n * 1024n ** 3n };
    await expect(createSavedWorkspaceLoader(db, { ...f.storage, getObject: async () => { throw original; } }, options)(f.input)).rejects.toBe(original);
    const opened: Array<{ cleanup(): Promise<void> }> = [];
    try {
      const load = createSavedWorkspaceLoader(db, f.storage, options);
      opened.push(await load(f.input)); opened.push(await load(f.input));
    } finally { await Promise.all(opened.map(access => access.cleanup())); }
  });

  it("owns failed decrypt cleanup beneath the Files reservation before releasing capacity", async () => {
    const f = await savedFileFixture(), original = new Error("synthetic decrypt cleanup failed");
    const load = createSavedWorkspaceLoader(db, f.storage, { availableBytes: async () => 8n * 1024n ** 3n });
    const opened: Array<{ cleanup(): Promise<void> }> = [];
    decryptCleanupFault.error = original; decryptCleanupFault.path = undefined;
    try {
      await expect(load(f.input)).rejects.toBe(original);
      const failed = decryptCleanupFault.path!;
      expect(path.basename(path.dirname(failed))).toMatch(/^pc-workspace-files-/);
      await expect(fs.stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.dirname(failed))).rejects.toMatchObject({ code: "ENOENT" });
      opened.push(await load(f.input)); opened.push(await load(f.input));
    } finally {
      decryptCleanupFault.error = undefined;
      await Promise.all(opened.map(access => access.cleanup()));
      if (decryptCleanupFault.path) await fs.rm(decryptCleanupFault.path, { recursive: true, force: true });
      decryptCleanupFault.path = undefined;
    }
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

  it("shares one verified saved extraction across 100 availability paths and removes it after the request", async () => {
    const f = await fixture();
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "availability-saved-"));
    directories.push(storageRoot);
    const paths = Array.from({ length: 100 }, (_, index) => `docs/result-${index}.md`);
    await Promise.all(paths.map(file => fs.writeFile(path.join(f.root, file), `Result ${file}\n`)));
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(storageRoot, "objects")));
    const archivePath = path.join(storageRoot, "saved.pcws");
    const archive = await captureRemoteWorkspaceDirectory({ cwd: f.root, archivePath });
    const [operation] = await db.insert(workspaceOperations).values({ companyId: f.ids.company,
      executionWorkspaceId: f.ids.workspace, phase: "synthetic_saved_fixture" }).returning();
    const snapshot = await beginWorkspaceSnapshot(db, { companyId: f.ids.company, workspaceId: f.ids.workspace,
      operationId: operation!.id, generation: 1, epoch: 1 });
    await uploadWorkspaceSnapshot({ db, storage, companyId: f.ids.company, workspaceId: f.ids.workspace,
      snapshotId: snapshot.id, archivePath, manifestDigest: archive.manifestDigest });
    await db.update(executionWorkspaceSnapshots).set({ status: "committed" }).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: null, snapshotId: snapshot.id } } })
      .where(eq(executionWorkspaces.id, f.ids.workspace));
    const loadSavedWorkspace = vi.fn(createSavedWorkspaceLoader(db, storage));
    const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace });
    const service = workspaceFileResourceService(db, undefined, { remoteFiles });

    const result = await service.availability(f.ids.issue, { queries: paths.map(file => ({ workspace: "execution", path: file })) });

    expect(result.results).toHaveLength(100);
    expect(result.results.every(item => item.openable && item.resource?.source?.kind === "saved")).toBe(true);
    expect(loadSavedWorkspace).toHaveBeenCalledTimes(1);
    for (const loaded of loadSavedWorkspace.mock.results) {
      const saved = await loaded.value;
      await expect(fs.stat(saved.root)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await service.availability(f.ids.issue, { queries: [{ workspace: "execution", path: paths[0]! }] });
    expect(loadSavedWorkspace).toHaveBeenCalledTimes(2);
    expect(f.execute).not.toHaveBeenCalled();
  }, 60_000);

  it.each(["null", "rejected", "unavailable"] as const)("shares a %s remote open across availability paths", async state => {
    const f = await fixture();
    const original = new Error("saved storage unavailable");
    const open = vi.fn(async () => {
      if (state === "rejected") throw original;
      if (state === "unavailable") throw unprocessable("Workspace files are unavailable", { code: "workspace_unavailable" });
      return null;
    });
    const result = workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: Array.from({ length: 20 }, (_, index) => ({ workspace: "execution", path: `result-${index}.md` })) });
    if (state === "rejected") await expect(result).rejects.toBe(original);
    else {
      const results = (await result).results;
      expect(results).toHaveLength(20);
      if (state === "unavailable") expect(results.every(item => item.unavailableReason === "workspace_unavailable")).toBe(true);
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("drains started availability checks before closing shared access and preserves the original error", async () => {
    const f = await fixture();
    let releaseSlow!: () => void;
    let announceSlow!: () => void;
    let announceError!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const slowStarted = new Promise<void>(resolve => { announceSlow = resolve; });
    const errorThrown = new Promise<void>(resolve => { announceError = resolve; });
    const original = new Error("availability read failed");
    const close = vi.fn(async () => { throw new Error("cleanup also failed"); });
    let slowFinished = false;
    const open = vi.fn(async () => ({
      source: { kind: "saved" as const, snapshotId: randomUUID(), savedAt: "2026-10-30T12:00:00.000Z" },
      stat: async (relativePath: string) => {
        if (relativePath === "error.md") {
          await slowStarted;
          announceError();
          throw original;
        }
        announceSlow();
        await slow;
        slowFinished = true;
        return { kind: "file" as const, relativePath, byteSize: 1, modifiedAt: null, text: true };
      },
      read: vi.fn(), list: vi.fn(), download: vi.fn(), close,
    }));
    const pending = workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: [{ workspace: "execution", path: "error.md" }, { workspace: "execution", path: "slow.md" }] });
    const observed = pending.catch(error => error);
    try {
      await errorThrown;
      await new Promise(resolve => setImmediate(resolve));
      expect(close).not.toHaveBeenCalled();
      expect(slowFinished).toBe(false);
    } finally { releaseSlow(); }
    expect(await observed).toBe(original);
    expect(slowFinished).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps denied availability paths ahead of opening a remote workspace", async () => {
    const f = await fixture();
    const open = vi.fn();
    const result = await workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: [".env", ".git/config", "../escape"].map(file => ({ workspace: "execution", path: file })) });
    expect(result.results.every(item => !item.openable)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("isolates availability task access from a project workspace with the same UUID", async () => {
    const f = await fixture();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.ids.company, name: "Remote project" });
    await db.insert(projectWorkspaces).values({ id: f.ids.workspace, companyId: f.ids.company, projectId,
      name: "Project root", sourceType: "remote_managed", isPrimary: true });
    await db.update(issues).set({ projectId, projectWorkspaceId: f.ids.workspace }).where(eq(issues.id, f.ids.issue));
    const close = vi.fn(async () => {});
    const stat = vi.fn(async (relativePath: string) => ({ kind: "file" as const, relativePath, byteSize: 1, modifiedAt: null, text: true }));
    const open = vi.fn(async () => ({ source: { kind: "live" as const, snapshotId: null, savedAt: null },
      stat, read: vi.fn(), list: vi.fn(), download: vi.fn(), close }));
    const result = await workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: [{ workspace: "execution", path: "result.md" }, { workspace: "project", path: "result.md" }] });
    expect(result.results.map(item => item.resource?.kind)).toEqual(["file", "remote_resource"]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("attempts every availability accessor close even when an earlier close fails", async () => {
    const f = await fixture();
    const otherWorkspace = randomUUID();
    await db.insert(executionWorkspaces).values({ id: otherWorkspace, companyId: f.ids.company, mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "cloud_sandbox", name: "Other task root", sourceIssueId: f.ids.issue });
    const cleanupFailure = new Error("first scratch cleanup failed");
    const closeFirst = vi.fn(async () => { throw cleanupFailure; });
    const closeOther = vi.fn(async () => {});
    const open = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      source: { kind: "live" as const, snapshotId: null, savedAt: null },
      stat: async (relativePath: string) => {
        if (workspaceId === f.ids.workspace) throw notFound("Workspace file not found");
        return { kind: "file" as const, relativePath, byteSize: 1, modifiedAt: null, text: true };
      },
      read: vi.fn(), list: vi.fn(), download: vi.fn(), close: workspaceId === f.ids.workspace ? closeFirst : closeOther,
    }));
    await expect(workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: [{ workspace: "auto", path: "one.md" }, { workspace: "auto", path: "two.md" }] })).rejects.toBe(cleanupFailure);
    expect(open).toHaveBeenCalledTimes(2);
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeOther).toHaveBeenCalledTimes(1);
  });

  it("rechecks saved authority for each availability stat on a shared accessor", async () => {
    const f = await fixture();
    const snapshotId = randomUUID();
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: null, snapshotId } } })
      .where(eq(executionWorkspaces.id, f.ids.workspace));
    const cleanup = vi.fn(async () => {});
    const loadSavedWorkspace = vi.fn(async () => ({ root: f.root, savedAt: "2026-10-30T12:00:00.000Z", cleanup }));
    const actual = createRemoteWorkspaceFiles(db, { loadSavedWorkspace });
    let changed!: () => void;
    const authorityChanged = new Promise<void>(resolve => { changed = resolve; });
    const open = vi.fn(async (input: Parameters<typeof actual.open>[0]) => {
      const access = (await actual.open(input))!;
      return { ...access, stat: async (relativePath: string) => {
        if (relativePath === "docs/after.md") await authorityChanged;
        const entry = await access.stat(relativePath);
        await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { ...f.authority, location: null, snapshotId, epoch: 2 } } })
          .where(eq(executionWorkspaces.id, f.ids.workspace));
        changed();
        return entry;
      } };
    });
    const result = await workspaceFileResourceService(db, undefined, { remoteFiles: { open } }).availability(f.ids.issue,
      { queries: [{ workspace: "execution", path: "docs/result.md" }, { workspace: "execution", path: "docs/after.md" }] });
    expect(result.results[0]!.openable).toBe(true);
    expect(result.results[1]!.unavailableReason).toBe("workspace_changed");
    expect(loadSavedWorkspace).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["confirmed_stop", "unknown_stop", "dirty", "foreign_receipt"])(
    "uses clean saved authority independently of an allocation's stop receipt (%s)", async state => {
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
      if (state !== "dirty") {
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
