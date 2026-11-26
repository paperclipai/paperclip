import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minioBinary, startMinio, type ObjectStore } from "./object-store.js";
import { planStorageFaults } from "./storage-chaos.js";
import { CredentialRotation, ROTATION_HOLD_MS, credentialFaultRules, freshCredentials, needsCredentialRotation,
  restartMinioWithCredentials, writeRotatingCredentialSource, type StoreCredentials } from "./storage-credentials.js";
import { faultResponse, startStorageFaultProxy, type StorageFaultRule } from "./storage-proxy.js";

const binary = minioBinary();
const s3 = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");

describe("ST5 credential faults", () => {
  it("plans 403 credential windows with a seeded error code, and rotation windows as a pass-through marker", () => {
    const windows = planStorageFaults({ kinds: ["ST5", "ST5R"], seed: 11, spanMs: 40 * 60_000 });
    expect(new Set(windows.map(window => window.kind))).toEqual(new Set(["ST5", "ST5R"]));
    const codes = new Set<string>();
    for (const window of windows) {
      const fault = window.rules[0]!.fault;
      if (window.kind === "ST5R") expect(window.rules).toEqual([{ fault: { kind: "credential_rotation" } }]);
      else if (fault.kind === "expired_credentials") codes.add(fault.code!);
      else throw new Error(`unexpected ST5 rule ${JSON.stringify(fault)}`);
    }
    expect([...codes].every(code => ["ExpiredToken", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(code))).toBe(true);
    expect(credentialFaultRules("ST5", () => 0.99)).toEqual([{ fault: { kind: "expired_credentials", code: "SignatureDoesNotMatch" } }]);
    expect(needsCredentialRotation({ storageFaults: ["ST5"] })).toBe(false);
    expect(needsCredentialRotation({ storageFaults: ["ST1", "ST5R"] })).toBe(true);
    expect(needsCredentialRotation({ storageWindows: windows.filter(window => window.kind === "ST5R") })).toBe(true);
  });

  it("answers each credential code as an S3 403 and passes rotation traffic through", () => {
    for (const code of ["ExpiredToken", "InvalidAccessKeyId", "SignatureDoesNotMatch"] as const) {
      const response = faultResponse({ kind: "expired_credentials", code });
      expect(response).toMatchObject({ status: 403 });
      expect((response as { body: string }).body).toContain(`<Code>${code}</Code>`);
    }
    expect(faultResponse({ kind: "expired_credentials" })).toMatchObject({ body: expect.stringContaining("ExpiredToken") });
    expect(faultResponse({ kind: "credential_rotation" })).toBeNull();
  });

  it("holds traffic while the store rotates, then publishes the new key only when the window ends", async () => {
    const applied: Array<readonly StorageFaultRule[] | "clear"> = [];
    const events: string[] = [];
    const published: StoreCredentials[] = [];
    let finishRotation!: () => void;
    const rotated = new Promise<void>(resolve => { finishRotation = resolve; });
    const next = { accessKeyId: "new", secretAccessKey: "secret" };
    const rotation = new CredentialRotation(() => rotated, { publish: async credentials => { published.push(credentials); } },
      kind => events.push(kind), () => next);
    const proxy = rotation.wrap({ setRules: rules => applied.push(rules), clear: () => applied.push("clear") });
    proxy.setRules([{ fault: { kind: "outage" } }]);
    expect(applied).toEqual([[{ fault: { kind: "outage" } }]]);
    proxy.setRules([{ fault: { kind: "credential_rotation" } }]);
    expect(applied.at(-1)).toEqual([{ fault: { kind: "latency", ms: ROTATION_HOLD_MS } }]);
    finishRotation();
    await vi.waitFor(() => expect(events).toEqual(["storage_credentials_rotated"]));
    expect(applied.at(-1)).toBe("clear");
    expect(published).toEqual([]);
    proxy.clear();
    await rotation.settled();
    expect(published).toEqual([next]);
    expect(events).toEqual(["storage_credentials_rotated", "storage_credentials_published"]);
  });

  it("does not undo a window that ended while the store was still rotating", async () => {
    const applied: Array<readonly StorageFaultRule[] | "clear"> = [];
    let finishRotation!: () => void;
    const rotation = new CredentialRotation(() => new Promise<void>(resolve => { finishRotation = resolve; }),
      { publish: async () => undefined }, () => undefined);
    const proxy = rotation.wrap({ setRules: rules => applied.push(rules), clear: () => applied.push("clear") });
    proxy.setRules([{ fault: { kind: "credential_rotation" } }]);
    proxy.clear();
    await vi.waitFor(() => expect(finishRotation).toBeTypeOf("function"));
    finishRotation();
    await rotation.settled();
    expect(applied.at(-1)).toBe("clear");
    expect(applied.filter(entry => entry === "clear")).toHaveLength(1);
  });
});

describe("ST5R rotation failures", () => {
  it("keeps rotation and publish errors so the wave can fail", async () => {
    const rotation = new CredentialRotation(async () => { throw new Error("minio did not restart"); },
      { publish: async () => { throw new Error("disk full"); } }, () => undefined);
    const proxy = rotation.wrap({ setRules: () => undefined, clear: () => undefined });
    proxy.setRules([{ fault: { kind: "credential_rotation" } }]);
    proxy.clear();
    await rotation.settled();
    expect(rotation.failures).toEqual(["rotation: Error: minio did not restart"]);
    const publishing = new CredentialRotation(async () => undefined, { publish: async () => { throw new Error("disk full"); } }, () => undefined);
    const wrapped = publishing.wrap({ setRules: () => undefined, clear: () => undefined });
    wrapped.setRules([{ fault: { kind: "credential_rotation" } }]);
    wrapped.clear();
    await publishing.settled();
    expect(publishing.failures).toEqual(["publish: Error: disk full"]);
  });

  async function fakeMinio(root: string, health: "ok" | "hang") {
    const binary = path.join(root, "fake-minio.mjs");
    await writeFile(binary, `#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const [host, port] = process.argv[process.argv.indexOf("--address") + 1].split(":");
writeFileSync(${JSON.stringify(path.join(root, "seen.json"))}, JSON.stringify({ user: process.env.MINIO_ROOT_USER, args: process.argv.slice(2) }));
createServer((req, res) => { if (${JSON.stringify(health)} === "ok") res.end("ok"); }).listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
`);
    await chmod(binary, 0o755);
    return binary;
  }

  async function storeOnFreePort(root: string): Promise<ObjectStore & { stopped: number }> {
    const proxy = await startStorageFaultProxy("http://127.0.0.1:9");
    const port = new URL(proxy.endpoint).port;
    await proxy.close();
    const store = { endpoint: `http://127.0.0.1:${port}`, bucket: "b", region: "us-east-1", accessKeyId: "old", secretAccessKey: "old-secret",
      dataDir: path.join(root, "object-store"), stopped: 0, stop: async () => { store.stopped += 1; } };
    return store;
  }

  it("restarts the store on the same address with the new root key and adopts its stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-st5r-fake-"));
    const store = await storeOnFreePort(root);
    const oldStop = store.stop;
    try {
      await restartMinioWithCredentials(store, await fakeMinio(root, "ok"), { accessKeyId: "new", secretAccessKey: "new-secret" }, 10_000);
      expect(store.stopped).toBe(1);
      expect(store).toMatchObject({ accessKeyId: "new", secretAccessKey: "new-secret" });
      expect(store.stop).not.toBe(oldStop);
      const seen = JSON.parse(await readFile(path.join(root, "seen.json"), "utf8"));
      expect(seen.user).toBe("new");
      expect(seen.args.slice(0, 4)).toEqual(["server", store.dataDir, "--address", new URL(store.endpoint).host]);
    } finally {
      await store.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("gives up at its deadline when the restarted store accepts connections but never answers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-st5r-hang-"));
    const store = await storeOnFreePort(root);
    try {
      const started = Date.now();
      await expect(restartMinioWithCredentials(store, await fakeMinio(root, "hang"), freshCredentials(), 1_500))
        .rejects.toThrow(/did not become ready/);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await store.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("ST5R real rotation", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.skipIf(!binary)("revokes the old key at the store, and only a client that re-resolves its profile keeps going", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-st5r-"));
    const store = await startMinio({ binary: binary!, root });
    const proxy = await startStorageFaultProxy(store.endpoint);
    const first = { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey };
    const source = await writeRotatingCredentialSource(root, first);
    for (const [key, value] of Object.entries(source.environment)) vi.stubEnv(key, value);
    const profileClient = new s3.S3Client({ endpoint: proxy.endpoint, region: store.region, forcePathStyle: true });
    const staticClient = new s3.S3Client({ endpoint: proxy.endpoint, region: store.region, forcePathStyle: true, credentials: first });
    const put = (client: typeof profileClient, key: string) => client.send(new s3.PutObjectCommand({ Bucket: store.bucket, Key: key, Body: key }));
    try {
      await put(profileClient, "before");
      const next = freshCredentials();
      await restartMinioWithCredentials(store, binary!, next);
      await source.publish(next);
      await expect(put(staticClient, "stale")).rejects.toMatchObject({ name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 } });
      await expect(put(profileClient, "cached")).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      await profileClient.config.credentials({ forceRefresh: true });
      await put(profileClient, "after");
      const listed = await profileClient.send(new s3.ListObjectsV2Command({ Bucket: store.bucket }));
      expect(listed.Contents.map((entry: { Key: string }) => entry.Key).sort()).toEqual(["after", "before"]);
    } finally {
      profileClient.destroy();
      staticClient.destroy();
      await proxy.close();
      await store.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
