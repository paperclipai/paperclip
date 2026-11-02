import { makeDirectoryTreeRemovable } from "./directory-cleanup.js";
/** Credential-free full-server overlap characterization. No model or Runner
 * continuity is claimed. Requires an explicitly selected disposable S3 service.
 * node --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/rolling-deployment-smoke.ts */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { createExternalControllerDatabase } from "./external-controller-database.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { createRunnerE2ETemporaryRoot } from "./server-config.js";
import { openRollingDeploymentBrowser } from "./rolling-deployment-browser.js";
import { startRollingDeploymentProcess } from "./rolling-deployment-process.js";
import { startRollingDeploymentProxy } from "./rolling-deployment-proxy.js";
import { startRollingStorageProxy } from "./rolling-deployment-storage-proxy.js";

// Exercise the SDK version owned by the server under test.
const { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } =
  createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const patchHash = createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 }));
for (const filename of execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean).sort()) {
  patchHash.update(filename).update("\0").update(await readFile(path.join(repositoryRoot, filename)));
}
const root = await createRunnerE2ETemporaryRoot();
const reportPath = path.join(root, "rolling-deployment-evidence.json");
const checks: { name: string; passed: boolean; error?: string }[] = [];
const report: Record<string, unknown> = {
  schema: "paperclip.e2e.rolling-deployment-smoke/v1", startedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
  sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim().length > 0,
  sourcePatchSha256: patchHash.digest("hex"), nodeVersion: process.version,
  lockfileSha256: createHash("sha256").update(await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"))).digest("hex"),
  artifactKind: "source", authentication: "local_trusted", readinessProbe: "/api/ready",
  activeAgentContinuityQualified: false, browserQualified: false, checks,
};
console.info(JSON.stringify({ started: true, evidence: reportPath }));
const saveReport = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const processes: Awaited<ReturnType<typeof startRollingDeploymentProcess>>[] = [];
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let proxy: Awaited<ReturnType<typeof startRollingDeploymentProxy>> | undefined;
let browser: Awaited<ReturnType<typeof openRollingDeploymentBrowser>> | undefined;
let storageProxy: Awaited<ReturnType<typeof startRollingStorageProxy>> | undefined;
let s3: InstanceType<typeof S3Client> | undefined;
const bucket = `rolling-deploy-${randomUUID()}`;
let bucketCreated = false;
let probing = false;
let probes: Promise<void> | undefined;
const requestErrors: string[] = [];
const acceptedWrites: string[] = [];
let reads = 0;
async function api(origin: string, route: string, method = "GET", body?: object) {
  const response = await fetch(`${origin}/api${route}`, {
    method, headers: { "content-type": "application/json", origin },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  await saveReport();
}
try {
  const storageFile = process.env.PAPERCLIP_ROLLING_TEST_STORAGE_CONFIG;
  if (!storageFile) throw new Error("Set PAPERCLIP_ROLLING_TEST_STORAGE_CONFIG to private disposable S3 connection JSON");
  const storage = JSON.parse(await readFile(storageFile, "utf8")) as {
    endpoint: string; accessKeyId: string; secretAccessKey: string;
  };
  const endpoint = new URL(storage.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || !storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error("Rolling smoke requires an explicit loopback S3 service with disposable credentials");
  }
  s3 = new S3Client({ region: "us-east-1", endpoint: storage.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
  storageProxy = await startRollingStorageProxy(storage.endpoint);
  const setupStarted = performance.now();
  if (process.env.PAPERCLIP_ROLLING_TEST_DATABASE_CONFIG) {
    const { url } = JSON.parse(await readFile(process.env.PAPERCLIP_ROLLING_TEST_DATABASE_CONFIG, "utf8")) as { url: string };
    const configPath = path.join(root, "database-owner/config.json");
    const owned = await createExternalControllerDatabase({ adminUrl: url, temporaryRoot: root,
      configPath, serverPort: await reserveRunnerE2EServerPort() });
    // Register cleanup before reading the generated configuration.
    database = { connectionString: "", cleanup: owned.cleanup };
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { database: { connectionString: string } };
    database.connectionString = saved.database.connectionString;
  } else {
    database = await startEmbeddedPostgresTestDatabase("rolling-deployment-");
  }
  proxy = await startRollingDeploymentProxy();
  const sharedEnvironment = {
    PAPERCLIP_DURABLE_AGENT_FILES: "true",
    PAPERCLIP_SHARED_UI_ASSETS: "true",
    PAPERCLIP_DATABASE_LISTEN_URL: database.connectionString,
    PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
    PAPERCLIP_AGENT_JWT_SECRET: randomUUID(), PAPERCLIP_DECISION_SIGNING_SECRET: randomUUID(),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
    PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: bucket,
    PAPERCLIP_STORAGE_S3_REGION: "us-east-1", PAPERCLIP_STORAGE_S3_ENDPOINT: storageProxy.endpoint,
    PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true", AWS_ACCESS_KEY_ID: storage.accessKeyId,
    AWS_SECRET_ACCESS_KEY: storage.secretAccessKey, AWS_EC2_METADATA_DISABLED: "true",
    RUN_LOG_S3_BUCKET: bucket, RUN_LOG_S3_ENDPOINT: storage.endpoint,
    RUN_LOG_S3_REGION: "us-east-1", RUN_LOG_S3_FORCE_PATH_STYLE: "true",
  };
  const browserEnabled = process.env.PAPERCLIP_ROLLING_TEST_BROWSER === "true";
  report.artifactKind = browserEnabled ? "compiled-server-with-workspace-dependencies" : "source";
  const omittedAssets = browserEnabled ? (await readdir(path.join(repositoryRoot, "ui/dist/assets"))).filter(name => /^CompanyActivity(?:\.production)?-[^.]+\.js$/.test(name)) : [];
  if (browserEnabled && !omittedAssets.length) throw new Error("Build the UI before browser qualification");
  const start = async (name: string, durableAgentFiles = true) => {
    const server = await startRollingDeploymentProcess({ root, name, repositoryRoot,
      databaseUrl: database!.connectionString, ingressOrigin: proxy!.origin,
      ...(browserEnabled ? { browser: name === "A" ? {} : { omitAssets: omittedAssets } } : {}),
      sharedEnvironment: { ...sharedEnvironment, PAPERCLIP_EPHEMERAL_SERVER: String(durableAgentFiles), PAPERCLIP_DURABLE_AGENT_FILES: String(durableAgentFiles) } });
    processes.push(server);
    report[`${name}Ready`] = await server.waitForReady();
    return server;
  };
  const a = await start("A"); proxy.routeTo(a.origin);
  report.setupElapsedMs = Math.round(performance.now() - setupStarted);
  const company = await api(proxy.origin, "/companies", "POST", { name: "Rolling deployment qualification" });
  const task = await api(proxy.origin, `/companies/${company.id}/issues`, "POST", { title: "Persist through deployment" });
  const agent = await api(proxy.origin, `/companies/${company.id}/agents`, "POST", {
    name: "Storage qualification", role: "engineer", adapterType: "process",
    adapterConfig: { command: "/usr/bin/true" },
  });
  const fileRoute = `/agents/${agent.id}/instructions-bundle/file`;
  await api(proxy.origin, fileRoute, "PUT", { path: "AGENTS.md", content: "Synthetic deployment fixture.", baseRevisionId: null });
  let content = `Acknowledged file ${randomUUID()}`;
  await api(proxy.origin, fileRoute, "PUT", { path: "reference.txt", content, baseHash: null });
  probing = true;
  probes = (async () => {
    let sequence = 0;
    while (probing) {
      try {
        const saved = await api(proxy!.origin, `/issues/${task.id}`); assert.equal(saved.id, task.id); reads++;
        if (sequence++ % 5 === 0) {
          const key = randomUUID();
          const comment = await api(proxy!.origin, `/issues/${task.id}/comments`, "POST", { body: key, clientRequestId: key });
          acceptedWrites.push(String(comment.id));
        }
      } catch (error) { requestErrors.push(error instanceof Error ? error.message : String(error)); }
      await delay(100);
    }
  })();
  if (browserEnabled) browser = await openRollingDeploymentBrowser({ origin: proxy.origin, root, taskTitle: task.title,
    taskPath: `/issues/${task.id}`, omittedAssets });
  await check("Unready replacement leaves the healthy server serving", async () => {
    const unready = await startRollingDeploymentProcess({ root, name: "unready", repositoryRoot,
      databaseUrl: database!.connectionString, ingressOrigin: proxy!.origin,
      sharedEnvironment: { ...sharedEnvironment, PAPERCLIP_EPHEMERAL_SERVER: "true", PAPERCLIP_DECISION_SIGNING_SECRET: "" } });
    processes.push(unready);
    await assert.rejects(unready.waitForReady(), /exited before readiness/);
    assert.equal((await api(proxy!.origin, `/issues/${task.id}`)).id, task.id);
    assert.equal((await api(a.origin, `/issues/${task.id}`)).id, task.id);
  });
  const b = await start("B");
  await check("B reads acknowledged task while A is alive", async () => {
    assert.equal((await api(b.origin, `/issues/${task.id}`)).title, task.title);
  });
  await check("B reads acknowledged agent file while A filesystem exists", async () => {
    assert.equal((await api(b.origin, `${fileRoute}?path=reference.txt`)).content, content);
  });
  await check("Concurrent servers observe file saves and enforce stale-write conflicts", async () => {
    const before = await api(a.origin, `${fileRoute}?path=reference.txt`);
    content = `Saved on B ${randomUUID()}`;
    await api(b.origin, fileRoute, "PUT", { path: "reference.txt", content, baseHash: before.contentHash });
    const onA = await api(a.origin, `${fileRoute}?path=reference.txt`);
    assert.equal(onA.content, content);
    const conflict = await fetch(`${a.origin}/api${fileRoute}`, { method: "PUT",
      headers: { "content-type": "application/json", origin: a.origin },
      body: JSON.stringify({ path: "reference.txt", content: "Stale write must fail", baseHash: before.contentHash }),
      signal: AbortSignal.timeout(10_000) });
    assert.equal(conflict.status, 409); await conflict.arrayBuffer();
    content = `Saved on A after B cached its files ${randomUUID()}`;
    await api(a.origin, fileRoute, "PUT", { path: "reference.txt", content, baseHash: onA.contentHash });
    assert.equal((await api(b.origin, `${fileRoute}?path=reference.txt`)).content, content);
  });
  const switchedAt = performance.now();
  await check("A finishes an admitted save after traffic switches and SIGTERM starts draining", async () => {
    storageProxy!.holdUploads();
    let acknowledged = false;
    const saving = api(proxy!.origin, fileRoute, "PUT", { path: "drained-save.txt", content: "Saved during HTTP drain", baseHash: null })
      .then(result => { acknowledged = true; return result; });
    void saving.catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      const deadline = Date.now() + 8_000;
      while (storageProxy!.heldUploads < 1 && Date.now() < deadline) await delay(25);
      assert.equal(storageProxy!.heldUploads, 1);
      proxy!.routeTo(b.origin);
      stopping = a.stop({ requireGraceful: true });
      await delay(100);
      assert.equal(acknowledged, false);
      storageProxy!.resumeUploads();
      assert.equal((await saving).content, "Saved during HTTP drain");
    } finally {
      storageProxy!.resumeUploads();
      await saving.catch(() => undefined);
      await stopping;
    }
  });
  proxy.routeTo(b.origin);
  await delay(500);
  await a.stop({ requireGraceful: true });
  await makeDirectoryTreeRemovable(a.home); await rm(a.home, { recursive: true });
  await delay(1_000);
  report.handoffElapsedMs = Math.round(performance.now() - switchedAt);
  if (browser) await check("Existing browser reconnects and opens an old lazy chunk after A removal", async () => {
    report.browser = browser!.metrics;
    await browser!.verifyReplacement(); report.browserQualified = true;
  });
  probing = false; await probes;
  report.reads = reads; report.acknowledgedWrites = acceptedWrites.length;
  await check("HTTP requests succeed across overlap and shutdown", async () => {
    assert.ok(reads > 0); assert.ok(acceptedWrites.length > 0); assert.deepEqual(requestErrors, []);
  });
  await check("Every acknowledged write survives A removal exactly once", async () => {
    const comments = await api(b.origin, `/issues/${task.id}/comments`) as unknown as { id: string }[];
    for (const id of acceptedWrites) assert.equal(comments.filter(comment => comment.id === id).length, 1);
  });
  await check("Agent file survives A filesystem removal", async () => {
    assert.equal((await api(b.origin, `${fileRoute}?path=reference.txt`)).content, content);
    assert.equal((await api(b.origin, `${fileRoute}?path=drained-save.txt`)).content, "Saved during HTTP drain");
  });
  await check("Object-store outage preserves files and leaves ordinary requests responsive", async () => {
    const fixtureAgents = await Promise.all([0, 1, 2].map(async index => {
      const fixture = await api(b.origin, `/companies/${company.id}/agents`, "POST", {
        name: `Storage failure ${index}`, role: "engineer", adapterType: "process", adapterConfig: { command: "/usr/bin/true" },
      });
      // Exercise both previously committed files and an agent's first save.
      if (index < 2) await api(b.origin, `/agents/${fixture.id}/instructions-bundle/file`, "PUT", {
        path: "AGENTS.md", content: "Durable original", baseRevisionId: null,
      });
      return { id: String(fixture.id), seeded: index < 2 };
    }));
    storageProxy!.holdUploads();
    const writes = Promise.all(fixtureAgents.map(fixture => fetch(`${b.origin}/api/agents/${fixture.id}/instructions-bundle/file`, {
      method: "PUT", headers: { "content-type": "application/json", origin: b.origin },
      body: JSON.stringify({ path: "failed.txt", content: "Must never become authoritative", baseHash: null }),
      signal: AbortSignal.timeout(40_000),
    }).then(async response => { await response.arrayBuffer(); return response.status; })));
    // Keep a rejection handler attached even if an earlier assertion fails.
    void writes.catch(() => undefined);
    try {
      const deadline = Date.now() + 10_000;
      while (storageProxy!.heldUploads < 2 && Date.now() < deadline) await delay(25);
      assert.equal(storageProxy!.heldUploads, 2, "Both file-transfer connections must be occupied before probing ordinary HTTP");
      const began = performance.now();
      assert.equal((await api(b.origin, `/issues/${task.id}`)).id, task.id);
      report.storageOutageReadMs = Math.round(performance.now() - began);
      assert.ok(Number(report.storageOutageReadMs) < 2_000);
      storageProxy!.rejectUploads();
      assert.ok((await writes).every(status => status >= 500));
    } finally {
      storageProxy!.rejectUploads();
      await writes.catch(() => undefined);
      storageProxy!.resumeUploads();
    }
    for (const fixture of fixtureAgents) {
      const route = `/agents/${fixture.id}/instructions-bundle/file`;
      const response = await fetch(`${b.origin}/api${route}?path=failed.txt`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      assert.equal(response.status, 404, `Failed-write read returned ${response.status}: ${body.slice(0, 300)}`);
      if (fixture.seeded) assert.equal((await api(b.origin, `${route}?path=AGENTS.md`)).content, "Durable original");
    }
  });
  await b.stop({ requireGraceful: true }); await makeDirectoryTreeRemovable(b.home); await rm(b.home, { recursive: true });
  const c = await start("C", false); proxy.routeTo(c.origin);
  await check("Fresh C restores files after both homes are deleted, even with adoption opt-in disabled", async () => {
    assert.equal((await api(c.origin, `${fileRoute}?path=reference.txt`)).content, content);
    assert.equal((await api(c.origin, `/issues/${task.id}`)).id, task.id);
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  probing = false;
  await probes;
  const cleanupErrors: string[] = [];
  const clean = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  };
  if (browser) await clean(() => browser!.close());
  for (const server of processes) await clean(() => server.stop());
  if (proxy) await clean(() => proxy!.close());
  if (storageProxy) await clean(() => storageProxy!.close());
  if (database) await clean(() => database!.cleanup());
  if (s3 && bucketCreated) await clean(async () => {
    while (true) {
      const objects = await s3!.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (!objects.Contents?.length) break;
      const deleted = await s3!.send(new DeleteObjectsCommand({ Bucket: bucket,
        Delete: { Objects: objects.Contents.map((object: { Key: string }) => ({ Key: object.Key })) } }));
      if (deleted.Errors?.length) throw new Error("Owned S3 bucket cleanup could not delete all objects");
    }
    await s3!.send(new DeleteBucketCommand({ Bucket: bucket }));
  });
  s3?.destroy();
  report.cleanupConfirmed = cleanupErrors.length === 0;
  if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
  report.passed = !report.error && checks.length > 0 && checks.every(item => item.passed) && report.cleanupConfirmed;
  await saveReport();
  console.info(JSON.stringify({ passed: report.passed, checks, evidence: reportPath, cleanupConfirmed: report.cleanupConfirmed }));
}
if (!report.passed) process.exitCode = 1;
