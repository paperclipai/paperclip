import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { withS3FailureDiagnostics } from "../storage/s3-failure.js";
import { endStorageOutageWaitOn, isStorageUnavailableError, reportStorageOutageWaitsTo, retryThroughStorageOutage, runInOwnStorageScope, runSharedStorageWork, storageOutageWaitFor, waitOutStorageOutages } from "../storage/storage-unavailable.js";
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

  it("lets nested and parallel waits ride out one outage shorter than the budget", async () => {
    const wide = { budgetMs: 600, firstDelayMs: 20, maxDelayMs: 40 };
    const endsAt = Date.now() + 300;
    const send = async () => (Date.now() < endsAt ? outage() : "ok");
    const nested = () => retryThroughStorageOutage(() => retryThroughStorageOutage(send, undefined, wide), undefined, wide);
    await expect(waitOutStorageOutages(() => Promise.all(Array.from({ length: 8 }, nested))))
      .resolves.toEqual(Array(8).fill("ok"));
  });

  it("gives up once one outage has lasted longer than the budget, however the waits overlap", async () => {
    const startedAt = Date.now();
    const failing = () => retryThroughStorageOutage(outage, undefined, policy);
    const results = await waitOutStorageOutages(() => Promise.allSettled(Array.from({ length: 4 }, failing)));
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(policy.budgetMs - policy.maxDelayMs);
    expect(Date.now() - startedAt).toBeLessThan(policy.budgetMs * 3);
  });

  it("keeps the limit when only some keys fail and other storage calls succeed", async () => {
    const startedAt = Date.now();
    const result = await waitOutStorageOutages(async () => {
      const reads = setInterval(() => void retryThroughStorageOutage(async () => "read", undefined, policy), 5);
      try {
        return await retryThroughStorageOutage(async () => {
          await retryThroughStorageOutage(async () => "head read", undefined, policy);
          return outage();
        }, undefined, policy).catch((error: unknown) => error);
      } finally { clearInterval(reads); }
    });
    expect(result).toMatchObject({ name: "ServiceUnavailable" });
    expect(Date.now() - startedAt).toBeLessThan(policy.budgetMs * 3);
  });

  it("keeps one operation's limit when another operation in the same run recovers from its own outage", async () => {
    const startedAt = Date.now();
    const result = await waitOutStorageOutages(async () => {
      let recovering = true;
      void (async () => {
        while (recovering) {
          let failed = false;
          await retryThroughStorageOutage(async () => (failed ? "recovered" : (failed = true, outage())), undefined, policy).catch(() => undefined);
        }
      })();
      try {
        return await retryThroughStorageOutage(outage, undefined, policy).catch((error: unknown) => error);
      } finally { recovering = false; }
    });
    expect(result).toMatchObject({ name: "ServiceUnavailable" });
    expect(Date.now() - startedAt).toBeLessThan(policy.budgetMs * 3);
  });

  it("gives a later outage its own limit once the waiting work recovered", async () => {
    await waitOutStorageOutages(async () => {
      const recoversAt = Date.now() + policy.budgetMs - 60;
      await expect(retryThroughStorageOutage(async () => (Date.now() < recoversAt ? outage() : "ok"), undefined, policy)).resolves.toBe("ok");
      const secondRecoversAt = Date.now() + policy.budgetMs - 60;
      await expect(retryThroughStorageOutage(async () => (Date.now() < secondRecoversAt ? outage() : "again"), undefined, policy)).resolves.toBe("again");
    });
  });

  it("gives a run started from a stopped run's cleanup its own scope", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("Stopped by a board operator"));
    const wide = { budgetMs: 2_000, firstDelayMs: 20, maxDelayMs: 40 };
    let calls = 0;
    const next = await waitOutStorageOutages(async () => {
      endStorageOutageWaitOn(stopped.signal);
      return runInOwnStorageScope(() => retryThroughStorageOutage(async () => (++calls < 3 ? outage() : "next run"), undefined, wide));
    });
    expect(next).toBe("next run");
  });

  it("lets one run's Stop end only its own wait, not shared work another run waits on", async () => {
    const endsAt = Date.now() + 150;
    const wide = { budgetMs: 2_000, firstDelayMs: 20, maxDelayMs: 40 };
    const stopA = new AbortController();
    let shared!: Promise<string>;
    const runA = waitOutStorageOutages(async () => {
      endStorageOutageWaitOn(stopA.signal);
      shared = runSharedStorageWork(() => retryThroughStorageOutage(async () => (Date.now() < endsAt ? outage() : "shared"), undefined, wide));
      return retryThroughStorageOutage(outage, undefined, wide);
    });
    setTimeout(() => stopA.abort(new Error("Stopped by a board operator")), 30);
    await expect(runA).rejects.toMatchObject({ name: "AbortError" });
    await expect(shared).resolves.toBe("shared");
  });

  it("tells the run's wait observer about each wait and reports one end per wait", async () => {
    const wide = { budgetMs: 2_000, firstDelayMs: 20, maxDelayMs: 40 };
    const waiting = vi.fn(), ended = vi.fn();
    const endsAt = Date.now() + 150;
    const send = async () => (Date.now() < endsAt ? outage() : "ok");
    await runInOwnStorageScope(async () => {
      reportStorageOutageWaitsTo({ waiting, ended });
      await expect(storageOutageWaitFor("restoring the workspace",
        () => retryThroughStorageOutage(() => retryThroughStorageOutage(send, undefined, wide), undefined, wide))).resolves.toBe("ok");
      await expect(retryThroughStorageOutage(async () => "no wait", undefined, wide)).resolves.toBe("no wait");
    });
    expect(waiting.mock.calls.length).toBeGreaterThan(1);
    expect(waiting).toHaveBeenCalledWith({ purpose: "restoring the workspace", waitedMs: expect.any(Number) });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ purpose: "restoring the workspace", waitedMs: expect.any(Number), recovered: true });
  });

  it("reports a wait that gave up, and keeps waiting when the observer throws", async () => {
    const ended = vi.fn();
    await runInOwnStorageScope(async () => {
      reportStorageOutageWaitsTo({ waiting: () => { throw new Error("status unavailable"); }, ended });
      await expect(retryThroughStorageOutage(outage, undefined, policy)).rejects.toMatchObject({ name: "ServiceUnavailable" });
    });
    expect(ended).toHaveBeenCalledWith({ purpose: "continuing", waitedMs: expect.any(Number), recovered: false });
  });

  it("keeps a run's wait observer when its Stop signal is attached", async () => {
    const waiting = vi.fn();
    let calls = 0;
    await runInOwnStorageScope(async () => {
      reportStorageOutageWaitsTo({ waiting, ended: vi.fn() });
      endStorageOutageWaitOn(new AbortController().signal);
      await retryThroughStorageOutage(async () => (++calls < 2 ? outage() : "ok"), undefined, policy);
    });
    expect(waiting).toHaveBeenCalledTimes(1);
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
