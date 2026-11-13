import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { removeRuntimeAssetTree } from "../services/native-runtime/runtime-asset-retention.js";

type Server = { child: ChildProcess; url: string; home: string; rpc(method: string, input?: Record<string, unknown>): Promise<any> };
const enabled = Boolean(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL && process.env.PAPERCLIP_TEST_S3_ENDPOINT);
describe.skipIf(!enabled)("skills survive web-server replacement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let s3: S3Client;
  const bucket = `paperclip-skills-${randomUUID()}`;
  const servers: Server[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ephemeral-skills-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-skills-process-"));
    s3 = new S3Client({ region: "us-east-1", endpoint: process.env.PAPERCLIP_TEST_S3_ENDPOINT, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 90_000);
  async function stop(server: Server) {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      const exited = once(server.child, "exit");
      server.child.kill("SIGKILL");
      await exited;
    }
  }
  afterAll(async () => {
    await Promise.all(servers.map(stop));
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (s3) {
      while (true) {
        const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!objects.Contents?.length) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(object => ({ Key: object.Key! })) } }));
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      s3.destroy();
    }
    if (root) await removeRuntimeAssetTree(root);
  }, 90_000);
  async function start(name: string): Promise<Server> {
    const home = path.join(root, name);
    const child = fork(fileURLToPath(new URL("./helpers/ephemeral-skills-server.ts", import.meta.url)), [], {
      execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))], stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, DATABASE_URL: database.connectionString, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "default",
        PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: bucket,
        PAPERCLIP_STORAGE_S3_ENDPOINT: process.env.PAPERCLIP_TEST_S3_ENDPOINT, PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true",
        PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED: "true", PAPERCLIP_LOG_LEVEL: "error", PAPERCLIP_TELEMETRY_ENABLED: "false" },
    });
    let logs = "";
    child.stdout?.on("data", data => { logs = (logs + data).slice(-5000); });
    child.stderr?.on("data", data => { logs = (logs + data).slice(-5000); });
    let nextId = 0;
    const server: Server = { child, home, url: "", rpc(method, input) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Fixture RPC timed out: ${method}\n${logs}`)); }, 30_000);
        const receive = (message: any) => { if (message.id === id) { cleanup(); message.error ? reject(new Error(message.error)) : resolve(message.result); } };
        const exit = () => { cleanup(); reject(new Error(`Fixture exited during ${method}: ${logs}`)); };
        const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); };
        child.on("message", receive); child.on("exit", exit); child.send({ id, method, input });
      });
    } };
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Fixture startup timed out: ${logs}`)); }, 60_000);
      const receive = (message: any) => { if (message.ready) { server.url = `http://127.0.0.1:${message.port}/api`; cleanup(); resolve(); } };
      const exit = () => { cleanup(); reject(new Error(`Fixture startup failed: ${logs}`)); };
      const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); };
      child.on("message", receive); child.on("exit", exit);
    });
    return server;
  }
  async function request(server: Server, route: string, method = "GET", body?: Record<string, unknown>, expected = 200) {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  }
  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ephemeral skill qualification", issuePrefix: `EP${companyId.slice(0, 5)}` });
    return companyId;
  }
  async function directoryBytes(directory: string): Promise<number> {
    let bytes = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(directory, entry.name);
      bytes += entry.isDirectory() ? await directoryBytes(absolute) : (await fs.stat(absolute)).size;
    }
    return bytes;
  }

  it("preserves unassigned content, exact receipts and executable delivery through A → B → C", async () => {
    const companyId = await company();
    const route = `/companies/${companyId}/skills`;
    const a = await start("a");
    const input = { name: "Cold fixture", slug: "cold-fixture", markdown: "# Version A\n", idempotencyKey: "create-once" };
    const created = await request(a, route, "POST", input, 201);
    const files = `${route}/${created.id}/files`;
    const script = await request(a, files, "PATCH", { path: "scripts/run.sh", content: "#!/bin/sh\ncat references/value.txt\n", executable: true, expectedVersionId: created.currentVersionId });
    const saved = await request(a, files, "PATCH", { path: "references/value.txt", content: "durable useful result\n", expectedVersionId: script.versionId });
    await request(a, route);
    await stop(a);
    await removeRuntimeAssetTree(a.home);
    await fs.writeFile(a.home, "predecessor filesystem unavailable");
    const b = await start("b");
    await b.rpc("metrics");
    expect((await request(b, route)).some((skill: any) => skill.id === created.id)).toBe(true);
    await request(b, `${route}/${created.id}/versions`);
    expect((await b.rpc("metrics")).downloads).toBe(0);
    const coldStarted = performance.now();
    expect(await request(b, `${files}?path=references/value.txt`)).toMatchObject({ content: "durable useful result\n", versionId: saved.versionId });
    const coldReadMs = performance.now() - coldStarted;
    const coldMetrics = await b.rpc("metrics");
    expect(coldMetrics.downloads).toBeGreaterThan(0);
    expect(await b.rpc("runtime", { companyId, key: created.key, execute: true })).toMatchObject({ versionId: saved.versionId, output: "durable useful result\n" });
    await b.rpc("metrics");
    const warm = await b.rpc("runtime", { companyId, key: created.key, execute: true });
    const warmMetrics = await b.rpc("metrics");
    expect(warmMetrics.downloads).toBe(0);
    const temporaryBytes = await directoryBytes(b.home);
    await b.rpc("faults", { lostResponse: true });
    const saveInput = { path: "SKILL.md", content: "# Version B\n", expectedVersionId: saved.versionId, idempotencyKey: "save-once" };
    await expect(request(b, files, "PATCH", saveInput)).rejects.toThrow();
    const receipt = await request(b, files, "PATCH", saveInput);
    expect(receipt).toMatchObject({ skillId: created.id, path: "SKILL.md" });
    const c = await start("c");
    expect(await request(c, `${files}?path=SKILL.md`)).toMatchObject({ content: "# Version B\n", versionId: receipt.versionId });
    expect(await request(c, route, "POST", input)).toEqual(created);
    await stop(b);
    await removeRuntimeAssetTree(b.home);
    expect(await c.rpc("runtime", { companyId, key: created.key, versionId: saved.versionId, execute: true }))
      .toMatchObject({ versionId: saved.versionId, markdown: "# Version A\n", output: "durable useful result\n" });
    expect(await request(c, files, "PATCH", { ...saveInput, content: "different" }, 409)).toHaveProperty("error");
    process.stdout.write(`${JSON.stringify({ qualification: "A-B-C", versions: [created.currentVersionId, saved.versionId, receipt.versionId],
      coldReadMs, coldDownloads: coldMetrics.downloads, coldObjectBytes: coldMetrics.downloadedBytes,
      warmMs: warm.elapsedMs, warmDownloads: warmMetrics.downloads, rssBytes: warmMetrics.memory.rss, temporaryBytes })}\n`);
  }, 180_000);

  it("rejects concurrent stale publication and survives upload failure or process death", async () => {
    const companyId = await company(), route = `/companies/${companyId}/skills`;
    const a = await start("concurrent-a"), b = await start("concurrent-b");
    const created = await request(a, route, "POST", { name: "Conflict", markdown: "# Stable\n" }, 201);
    const files = `${route}/${created.id}/files`;
    await request(a, `${files}?path=SKILL.md`);
    const edit = await request(b, files, "PATCH", { path: "first.txt", content: "B", expectedVersionId: created.currentVersionId });
    await request(a, files, "PATCH", { path: "second.txt", content: "A", expectedVersionId: created.currentVersionId }, 409);
    expect(await request(a, `${files}?path=first.txt`)).toMatchObject({ content: "B", versionId: edit.versionId });
    await a.rpc("faults", { failUploads: true });
    await request(a, files, "PATCH", { path: "SKILL.md", content: "# Must not commit\n", expectedVersionId: edit.versionId }, 500);
    expect(await request(b, `${files}?path=SKILL.md`)).toMatchObject({ content: "# Stable\n", versionId: edit.versionId });
    await a.rpc("faults", { crashAfterUpload: true });
    await expect(request(a, files, "PATCH", { path: "SKILL.md", content: "# Crash candidate\n", expectedVersionId: edit.versionId })).rejects.toThrow();
    expect(await request(b, `${files}?path=SKILL.md`)).toMatchObject({ content: "# Stable\n", versionId: edit.versionId });
  }, 180_000);
});
