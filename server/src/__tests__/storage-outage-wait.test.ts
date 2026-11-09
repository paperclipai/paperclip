import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { withS3FailureDiagnostics } from "../storage/s3-failure.js";
import { isStorageUnavailableError, retryThroughStorageOutage, waitOutStorageOutages } from "../storage/storage-unavailable.js";
import { RemoteWorkspaceRestoreError } from "../services/remote-workspace-transport.js";

const OUTAGE = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>ServiceUnavailable</Code><Message>Injected storage outage</Message><RequestId>req-503</RequestId></Error>`;

let outageUntil = 0;
let requests = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests++;
    if (Date.now() < outageUntil) {
      res.writeHead(503, { "content-type": "application/xml" });
      res.end(OUTAGE);
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-length": "5", etag: '"v1"' });
      res.end("saved");
      return;
    }
    res.writeHead(200, { etag: '"v2"' });
    res.end();
  });
});
const savedEnv = { ...process.env };
let endpoint = "";

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});
afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => { requests = 0; outageUntil = 0; });

const provider = () => createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });

async function read(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

describe("waiting out a storage outage on a run's critical path (Daytona storage chaos ST1)", () => {
  it("restores a saved object once the store is back instead of failing the run", async () => {
    outageUntil = Date.now() + 3_000;
    const object = await waitOutStorageOutages(() => provider().getObject({ objectKey: "company/workspace.pcws" }));
    expect(await read(object.stream)).toBe("saved");
    expect(requests).toBeGreaterThan(1);
  }, 30_000);

  it("claims the run log once the store is back", async () => {
    outageUntil = Date.now() + 3_000;
    await expect(waitOutStorageOutages(() => provider().putObjectConditional!({ objectKey: "company/runs/head.json",
      body: Buffer.from("{}"), contentType: "application/json", contentLength: 2, ifNoneMatch: "*" })))
      .resolves.toEqual({ etag: '"v2"' });
  }, 30_000);

  it("keeps failing fast outside a run's critical path", async () => {
    outageUntil = Date.now() + 60_000;
    const startedAt = Date.now();
    await expect(provider().headObject({ objectKey: "company/avatar.png" })).rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 30_000);

  it("stops waiting when the run is stopped", async () => {
    outageUntil = Date.now() + 60_000;
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("Stopped by a board operator")), 3_000);
    const startedAt = Date.now();
    await expect(waitOutStorageOutages(() => provider().getObject({ objectKey: "company/workspace.pcws", signal: stop.signal })))
      .rejects.toBeTruthy();
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);
});

describe("the shared storage outage wait", () => {
  const outage = () => withS3FailureDiagnostics("get_object", async () => {
    throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
  });
  const policy = { budgetMs: 200, firstDelayMs: 10, maxDelayMs: 40 };

  it("retries until the store answers, within its budget", async () => {
    let calls = 0;
    await expect(retryThroughStorageOutage(async () => (++calls < 4 ? outage() : "ok"), undefined, policy)).resolves.toBe("ok");
    expect(calls).toBe(4);
  });

  it("gives the outage back to the run's storage wait once the budget is spent", async () => {
    let calls = 0;
    await expect(retryThroughStorageOutage(async () => { calls++; return outage(); }, undefined, policy))
      .rejects.toMatchObject({ name: "ServiceUnavailable" });
    expect(calls).toBeGreaterThan(1);
  });

  it("keeps the storage failure when a deadline ends the wait, but not when a Stop does", async () => {
    const slow = { budgetMs: 60_000, firstDelayMs: 1_000, maxDelayMs: 1_000 };
    await expect(retryThroughStorageOutage(outage, AbortSignal.timeout(50), slow))
      .rejects.toSatisfy(isStorageUnavailableError);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("Stopped by a board operator")), 50);
    const stopped = await retryThroughStorageOutage(outage, stop.signal, slow).catch((error: unknown) => error);
    expect(stopped).toMatchObject({ name: "AbortError" });
    expect(isStorageUnavailableError(stopped)).toBe(false);
  });

  it("shares one outage budget across a run's storage calls", async () => {
    let calls = 0;
    const failing = async () => { calls++; return outage(); };
    await waitOutStorageOutages(async () => {
      await expect(retryThroughStorageOutage(failing, undefined, policy)).rejects.toMatchObject({ name: "ServiceUnavailable" });
      const spent = calls;
      await waitOutStorageOutages(() => expect(retryThroughStorageOutage(failing, undefined, policy))
        .rejects.toMatchObject({ name: "ServiceUnavailable" }));
      expect(spent).toBeGreaterThan(4);
      expect(calls - spent).toBeLessThan(3);
    });
  });

  it("counts time spent in failed requests against the budget", async () => {
    let calls = 0;
    const slow = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 120)); return outage(); };
    await expect(retryThroughStorageOutage(slow, undefined, policy)).rejects.toMatchObject({ name: "ServiceUnavailable" });
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("never retries a failure that is not an outage", async () => {
    let calls = 0;
    await expect(retryThroughStorageOutage(async () => { calls++; throw new Error("object_journal_conflict"); }, undefined, policy))
      .rejects.toThrow("object_journal_conflict");
    expect(calls).toBe(1);
  });

  it("recognizes an outage a workspace restore wrapped (snapshot_download)", async () => {
    const cause = await outage().catch(error => error);
    expect(isStorageUnavailableError(new RemoteWorkspaceRestoreError("snapshot_download", true, cause))).toBe(true);
    expect(isStorageUnavailableError(new RemoteWorkspaceRestoreError("sandbox_restore", true, new Error("reason=occupied")))).toBe(false);
  });
});
