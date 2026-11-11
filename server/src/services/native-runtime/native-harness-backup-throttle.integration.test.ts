import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../../storage/s3-provider.js";
import { createStorageService } from "../../storage/service.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";

// Durable harness backups against an S3 endpoint that throttles requests.
describeEmbeddedPostgres("durable native provider backups under an object-storage request-rate limit", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
  afterEach(async () => {
    for (const home of ownedHomes.splice(0)) await removeNativeHarnessBackup(home);
    vi.unstubAllEnvs();
  });
  async function fixture(provider = "codex") {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, runtimeRoot, successor } = environment.current;
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: "backup-writer", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId, issueId: f.issueId, runId: f.runId, bootId: successor.bootId });
    const home = join(runtimeRoot, randomUUID()), root = join(home, "failover-backups", "current");
    ownedHomes.push(home);
    await mkdir(join(root, provider, "sessions"), { recursive: true });
    await mkdir(join(root, "runner"));
    const identity = { normalizedSessionId: randomUUID(), providerSessionId: randomUUID(), provider };
    await writeFile(join(root, provider, "sessions", "history.json"), JSON.stringify(identity), { mode: 0o600 });
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ runId: f.runId, lifecycle: "suspended" }), { mode: 0o600 });
    const manifest = JSON.stringify({ schema: "paperclip.native-harness-backup.v1", ...identity, directories: [provider, "runner"] });
    await writeFile(join(root, "manifest.json"), manifest, { mode: 0o600 });
    await chmod(join(root, provider, "sessions"), 0o500);
    const sessionScopeId = randomUUID(), scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    return { ...f, home, root, companyId, owner, scopeDigest, sessionScopeId, storage, identity,
      manifestSha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}` };
  }
  async function artifactFixture(artifactVersion = randomUUID()) {
    const f = await fixture("opencode");
    const sourceRoot = join(f.home, "qualified-provider-pack");
    await mkdir(sourceRoot);
    const original = { nodeCommand: "qualified Node executable", opencodeExecutable: "qualified OpenCode executable",
      opencodeProxy: `qualified original proxy bytes ${artifactVersion}` };
    const artifacts = Object.fromEntries(await Promise.all(Object.entries(original).map(async ([name, bytes]) => {
      await writeFile(join(sourceRoot, name), bytes, { mode: 0o500 });
      return [name, { path: name, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }];
    })));
    const payload = { runnerSourceRevision: "a".repeat(40), target: { platform: "linux", architecture: "x64" },
      pins: { opencode: "1.18.34" }, artifacts: { ...artifacts, opencodeCommand: artifacts.opencodeExecutable } };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` };
    const launchRoot = `/home/daytona/.paperclip-runtime/paperclip-runner/provider-artifacts/${manifest.digest.slice(7)}`;
    await f.db.update(heartbeatRuns).set({ nativeSessionId: f.identity.normalizedSessionId, driverKind: "opencode_server",
      runnerProfileJson: { ...f.preparedProfile, nativeProviderPackAdmissionState: {
        schema: "paperclip.native-provider-pack-admission-state.v1", state: "verified", admissionEpoch: randomUUID() },
      nativeProviderPackAdmission: { schema: "paperclip.native-provider-pack-admission.v1", stage: "session_admitted",
        authority: "core_verified_selection", companyId: f.companyId, agentId: environment.current.agentId,
        runId: f.runId, sessionId: f.identity.normalizedSessionId, runnerInstanceId: "artifact-fixture-runner",
        runnerEnvironmentLeaseId: "artifact-fixture-lease", providerPackDigest: manifest.digest,
        opencodeProxySha256: artifacts.opencodeProxy.sha256, sourceRevision: payload.runnerSourceRevision } },
    }).where(eq(heartbeatRuns.id, f.runId));
    return { ...f, original, manifest, launchRoot, providerArtifacts: { sourceRoot, manifest, launchRoot, accountUid: 1000 } };
  }
  // Staging: two OpenCode per-turn runs had an accepted result, but object
  // storage answered the backup upload with one 503 SlowDown ("Please reduce
  // your request rate."). The upload was a single stream PUT that nothing
  // retried, so the only provider-session backup was lost when the sandbox was
  // released, and the follow-up could not resume.
  it.each(["Codex backup", "OpenCode backup with provider artifacts"])("backs off and publishes when object storage throttles each %s upload and read-back once", async label => {
    const f = label.startsWith("OpenCode") ? await artifactFixture() : await fixture();
    const objects = new Map<string, Buffer>(), throttled = new Set<string>(), throttledReads = new Set<string>(); let puts = 0, reads = 0;
    const server = createServer((request, response) => {
      const key = new URL(request.url!, "http://localhost").pathname;
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "PUT") {
          puts++;
          if (!throttled.has(key)) {
            throttled.add(key);
            response.writeHead(503, { "Content-Type": "application/xml" }).end(
              "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>throttled</RequestId></Error>");
            return;
          }
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200, { ETag: `"${createHash("md5").update(objects.get(key)!).digest("hex")}"` }).end();
        } else if (request.method === "GET" || request.method === "HEAD") {
          const body = objects.get(key);
          if (request.method === "GET" && body) {
            reads++;
            if (!throttledReads.has(key)) {
              throttledReads.add(key);
              response.writeHead(503, { "Content-Type": "application/xml" }).end(
                "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>throttled-read</RequestId></Error>");
              return;
            }
          }
          if (!body) { response.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
          response.writeHead(200, { "Content-Length": body.length, ETag: `"${createHash("md5").update(body).digest("hex")}"`,
            "Content-Type": "application/octet-stream" }).end(request.method === "GET" ? body : undefined);
        } else if (request.method === "DELETE") {
          objects.delete(key); response.writeHead(204).end();
        } else response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture");
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    try {
      await persistNativeHarnessBackup({ ...f, storage });
      // Every object was refused once and then stored: the harness archive, and
      // for OpenCode the provider artifact bundle too.
      expect(throttled.size).toBe(label.startsWith("OpenCode") ? 2 : 1);
      expect(puts).toBe(2 * throttled.size);
      expect(objects.size).toBe(throttled.size);
      // The verification read after each upload was refused once and repeated
      // (the S3 client already resends a bodiless GET after SlowDown).
      expect(throttledReads.size).toBe(throttled.size);
      expect(reads).toBe(2 * throttled.size);
      const [current] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
        eq(nativeHarnessBackups.status, "current")));
      expect(current).toBeDefined();
      const replacement = join(environment.current.runtimeRoot, randomUUID(), "restored-throttled"); ownedHomes.push(replacement);
      expect(await restoreDurableNativeHarnessBackup({ ...f, storage, backupRoot: replacement })).toBe(true);
      const providerDirectory = label.startsWith("OpenCode") ? "opencode" : "codex";
      expect(JSON.parse(await readFile(join(replacement, "current", providerDirectory, "sessions", "history.json"), "utf8"))).toEqual(f.identity);
    } finally {
      random.mockRestore(); warn.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
