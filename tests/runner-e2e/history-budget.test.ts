import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedHistoryPublisher, checkHistoryPayload, HISTORY_LIMITS, validateBoundedHistoryRetention } from "./history-budget.js";
import { createBundleManifest, uploadImmutableBundle } from "./history-publish.js";
import { buildRunnerCampaign, campaignHistoryRecord, emptyRunnerHistory, mergeRunnerHistory } from "./history.js";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-budget-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

function lifecycle() {
  return { Rules: [
    { Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
    { Status: "Enabled", Filter: { Prefix: "runner-e2e/bounded-v1/" }, Expiration: { Days: 30 },
      NoncurrentVersionExpiration: { NoncurrentDays: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    { Status: "Enabled", Filter: { Prefix: "runner-e2e/bounded-v1/" }, Expiration: { ExpiredObjectDeleteMarker: true } },
  ] };
}
function providerError(code: string) { return Object.assign(new Error("provider failure"), { stderr: `An error occurred (${code})` }); }

describe("bounded public history", () => {
  it("rejects excess bytes, count, invalid sizes and duplicate paths", () => {
    expect(checkHistoryPayload([{ path: "a", bytes: 8 }], 8, 1, "report")).toEqual({ files: 1, bytes: 8 });
    for (const files of [[{ path: "a", bytes: 9 }], [{ path: "a", bytes: -1 }],
      [{ path: "a", bytes: 0 }, { path: "b", bytes: 0 }], [{ path: "a", bytes: 0 }, { path: "a", bytes: 0 }]]) {
      expect(() => checkHistoryPayload(files, 8, 1, "report")).toThrow();
    }
  });

  it("rejects oversized real bundle files before hashing them", async () => {
    const root = await temporary();
    await writeFile(path.join(root, "index.html"), "");
    await truncate(path.join(root, "index.html"), HISTORY_LIMITS.campaignBytes + 1);
    await expect(createBundleManifest(root, "oversized", false, new Set(), true)).rejects.toThrow("publication boundary");
  });

  it("uploads an allowlisted uppercase PNG with the same raster content type", async () => {
    const root = await temporary(); const bundle = path.join(root, "bundle");
    const screenshot = "evidence/execution/attempt-1/shot.PNG";
    await mkdir(path.dirname(path.join(bundle, screenshot)), { recursive: true });
    await writeFile(path.join(bundle, screenshot), Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"));
    const manifest = await createBundleManifest(bundle, "uppercase", false, new Set([screenshot]), true);
    const runner = vi.fn(async () => ({ stdout: "{}" }));
    await uploadImmutableBundle("bucket", "campaigns/uppercase", bundle, manifest,
      new BoundedHistoryPublisher(path.join(root, "receipt.json"), runner));
    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(["--content-type", "image/png", "--key", `campaigns/uppercase/${screenshot}`]), expect.any(Number));
  });

  it("requires expiration for both current and noncurrent versions in the isolated prefix", () => {
    expect(() => validateBoundedHistoryRetention(lifecycle(), "runner-e2e/bounded-v1")).not.toThrow();
    expect(() => validateBoundedHistoryRetention(lifecycle(), "runner-e2e")).toThrow("isolated");
    for (const mutate of [
      (config: ReturnType<typeof lifecycle>) => { config.Rules[1]!.Status = "Disabled"; },
      (config: ReturnType<typeof lifecycle>) => { config.Rules[1]!.NoncurrentVersionExpiration = undefined; },
      (config: ReturnType<typeof lifecycle>) => { Object.assign(config.Rules[1]!.NoncurrentVersionExpiration!, { NewerNoncurrentVersions: 10 }); },
      (config: ReturnType<typeof lifecycle>) => { Object.assign(config.Rules[1]!.Filter, { Tag: { Key: "optional", Value: "true" } }); },
      (config: ReturnType<typeof lifecycle>) => { config.Rules.pop(); },
    ]) {
      const config = lifecycle(); mutate(config);
      expect(() => validateBoundedHistoryRetention(config, "runner-e2e/bounded-v1")).toThrow("expiry");
    }
  });

  it("rejects overlapping transitions or earlier expiration without affecting unrelated prefixes", () => {
    const config = lifecycle();
    Object.assign(config.Rules[0]!, { Transitions: [{ Days: 1, StorageClass: "GLACIER" }] });
    expect(() => validateBoundedHistoryRetention(config, "runner-e2e/bounded-v1")).toThrow("overlapping");
    config.Rules[0]!.Filter.Prefix = "storybook/";
    expect(() => validateBoundedHistoryRetention(config, "runner-e2e/bounded-v1")).not.toThrow();
    Object.assign(config.Rules[2]!.Expiration!, { Days: 1 });
    expect(() => validateBoundedHistoryRetention(config, "runner-e2e/bounded-v1")).toThrow("overlapping");
  });

  it("rebuilds pointers after removing old, future and excess history records", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const record = (id: string, age: number) => campaignHistoryRecord(buildRunnerCampaign({ campaignId: id,
      generatedAt: new Date(now - age * 86_400_000).toISOString(), expected: [], results: [] }), "https://example.test/bounded-v1");
    const old = { ...record("expired-green", 29), complete: true, failed: 0 };
    const current = { ...emptyRunnerHistory(), campaigns: [old, record("future", -2), record("yesterday", 1), record("earlier", 2)] };
    const result = mergeRunnerHistory(current, record("today", 0), { now, maxAgeMs: 28 * 86_400_000, maxCampaigns: 2 });
    expect(result.campaigns.map(row => row.campaignId)).toEqual(["today", "yesterday"]);
    expect(result.latestCampaignId).toBe("today");
    expect(result.latestGreenCampaignId).not.toBe("expired-green");
    expect(current.campaigns).toHaveLength(4);
  });

  it("distinguishes absent lock/replication from denied inspection", async () => {
    const root = await temporary();
    const runner = vi.fn(async (args: string[]) => {
      if (args[1] === "get-bucket-versioning") return { stdout: '{"Status":"Enabled"}' };
      if (args[1] === "get-bucket-lifecycle-configuration") return { stdout: JSON.stringify(lifecycle()) };
      throw providerError(args[1] === "get-object-lock-configuration" ? "ObjectLockConfigurationNotFoundError" : "ReplicationConfigurationNotFoundError");
    });
    await new BoundedHistoryPublisher(path.join(root, "allowed.json"), runner).verifyRetention("bucket", "runner-e2e/bounded-v1");
    runner.mockImplementation(async () => { throw providerError("AccessDenied"); });
    await expect(new BoundedHistoryPublisher(path.join(root, "denied.json"), runner).verifyRetention("bucket", "runner-e2e/bounded-v1")).rejects.toThrow();
  });

  it.each(["get-object-lock-configuration", "get-bucket-replication"])("rejects configured %s", async blocked => {
    const root = await temporary();
    const runner = async (args: string[]) => {
      if (args[1] === "get-bucket-versioning") return { stdout: '{"Status":"Enabled"}' };
      if (args[1] === "get-bucket-lifecycle-configuration") return { stdout: JSON.stringify(lifecycle()) };
      if (args[1] === blocked) return { stdout: "{}" };
      throw providerError("ObjectLockConfigurationNotFoundError");
    };
    await expect(new BoundedHistoryPublisher(path.join(root, "receipt.json"), runner).verifyRetention("bucket", "runner-e2e/bounded-v1")).rejects.toThrow("cannot prove");
  });

  it("bounds history reads and preserves permission errors", async () => {
    const root = await temporary(); const destination = path.join(root, "download.json");
    const runner = vi.fn(async (args: string[]) => {
      expect(args).toContain(`bytes=0-${HISTORY_LIMITS.jsonBytes}`);
      await writeFile(destination, ""); await truncate(destination, HISTORY_LIMITS.jsonBytes + 1);
      return { stdout: "{}" };
    });
    const publisher = new BoundedHistoryPublisher(path.join(root, "receipt.json"), runner);
    await expect(publisher.downloadJson("bucket", "history.json", destination)).rejects.toThrow("read boundary");
    runner.mockImplementation(async () => { throw providerError("NoSuchKey"); });
    await expect(publisher.downloadJson("bucket", "missing", destination)).resolves.toBeNull();
    runner.mockImplementation(async () => { throw providerError("AccessDenied"); });
    await expect(publisher.downloadJson("bucket", "denied", destination)).rejects.toThrow();
  });

  it("retains an attempted upload before dispatch and preserves unknown failures", async () => {
    const root = await temporary(); const receipt = path.join(root, "receipt.json"); const source = path.join(root, "source.json");
    await writeFile(source, "12345");
    const runner = vi.fn(async (args: string[], timeout: number) => {
      expect(args).toContain("--if-none-match"); expect(args).toContain("STANDARD"); expect(timeout).toBeLessThanOrEqual(30_000);
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ attemptedSourceBytes: 5, requests: [{ status: "unknown" }] });
      throw new Error("lost response");
    });
    const publisher = new BoundedHistoryPublisher(receipt, runner);
    await expect(publisher.upload("bucket", "campaign/a", source, "application/json", "no-cache", true)).rejects.toThrow("lost response");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ billedUsd: null, attemptedSourceBytes: 5,
      requests: [{ operation: "put-object", status: "failed_or_unknown", sourceBytes: 5 }] });
  });

  it("stops before another command when the request or elapsed-time boundary is reached", async () => {
    const root = await temporary(); const runner = vi.fn(async () => ({ stdout: "{}" }));
    const publisher = new BoundedHistoryPublisher(path.join(root, "receipt.json"), runner);
    for (let i = 0; i < HISTORY_LIMITS.requests; i++) await publisher.run(["s3api", "head-object"]);
    await expect(publisher.run(["s3api", "head-object"])).rejects.toThrow("allowance");
    expect(runner).toHaveBeenCalledTimes(HISTORY_LIMITS.requests);
    const timed = new BoundedHistoryPublisher(path.join(root, "timed.json"), runner);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HISTORY_LIMITS.deadlineMs + 1);
    await expect(timed.run(["s3api", "head-object"])).rejects.toThrow("allowance");
    expect(runner).toHaveBeenCalledTimes(HISTORY_LIMITS.requests);
  });

  it("retains the object identity and provider version separately from billed cost", async () => {
    const root = await temporary(); const receipt = path.join(root, "receipt.json"); const source = path.join(root, "source.json");
    await writeFile(source, "{}");
    const publisher = new BoundedHistoryPublisher(receipt, async () => ({ stdout: '{"VersionId":"version-1","ETag":"etag-1"}' }));
    await publisher.upload("bucket", "campaign/result.json", source, "application/json", "no-cache", true);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ billedUsd: null, requests: [{
      operation: "put-object", status: "accepted", bucket: "bucket", key: "campaign/result.json", versionId: "version-1", etag: "etag-1", sourceBytes: 2,
    }] });
  });
});
