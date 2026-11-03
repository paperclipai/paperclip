import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionFailure } from "../connection-config.js";
import { createObservedReader } from "./observation-read.js";

afterEach(() => vi.useRealTimers());
describe("bounded observation reads", () => {
  it("rejects a successful in-flight read that finishes after the original deadline", async () => {
    vi.useFakeTimers();
    const get = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ id: "late" }), 75)));
    const reader = createObservedReader({ get } as any, Date.now() + 50);
    const result = reader.get("/api/issues/owned").then(value => ({ value, error: undefined }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(75);
    expect((await result).error).toMatchObject({ code: "observation_read_deadline" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("ends an in-flight read at the original deadline even when the transport does not settle", async () => {
    vi.useFakeTimers();
    const get = vi.fn(() => new Promise(() => {}));
    let failure: unknown;
    const result = createObservedReader({ get } as any, Date.now() + 50).get("/api/issues/owned").catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(50);
    expect(failure).toMatchObject({ code: "observation_read_deadline" });
    await result;
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("passes the remaining deadline to the transport without extending its normal timeout", async () => {
    const get = vi.fn().mockResolvedValue({ id: "owned" });
    await createObservedReader({ get }, Date.now() + 50).get("/api/issues/owned");
    expect(get.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(0);
    expect(get.mock.calls[0]?.[1]?.timeoutMs).toBeLessThanOrEqual(50);
    await createObservedReader({ get }, Date.now() + 100_000).get("/api/issues/owned");
    expect(get.mock.calls[1]?.[1]).toEqual({ timeoutMs: 30_000 });
  });
  it.each(["api_request_failed", "api_status_408", "api_status_429", "api_status_502", "api_status_503", "api_status_504"])("retains and retries %s without replaying work", async code => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValueOnce(new ConnectionFailure(code)).mockResolvedValue({ id: "owned" });
    const reader = createObservedReader({ get }, Date.now() + 2000), result = reader.get("/api/issues/owned");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ id: "owned" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(reader.failures).toEqual([{ route: "/api/issues/owned", code }]);
  });
  it.each(["api_status_401", "api_status_403", "api_status_404", "api_status_409", "api_status_422", "api_status_500", "invalid_api_route"])("preserves %s as a failure", async code => {
    const error = new ConnectionFailure(code), get = vi.fn().mockRejectedValue(error);
    const reader = createObservedReader({ get }, Date.now() + 2000);
    await expect(reader.get("/api/issues/owned")).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
    expect(reader.failures).toEqual(code === "invalid_api_route" ? [] : [{ route: "/api/issues/owned", code }]);
  });
  it("saves a fatal status receipt to private evidence without retrying", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "qa-observation-evidence-"));
    const error = new ConnectionFailure("api_status_422"), get = vi.fn().mockRejectedValue(error);
    const reader = createObservedReader({ get }, Date.now() + 2000);
    try {
      await expect(reader.get("/api/issues/owned/documents/result")).rejects.toBe(error);
      await reader.preserve(directory);
      expect(JSON.parse(await readFile(path.join(directory, "observation-read-failures.json"), "utf8"))).toEqual({
        failures: [{ route: "/api/issues/owned/documents/result", code: "api_status_422" }],
      });
      expect(get).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("excludes arbitrary error text from the closed receipt", async () => {
    const error = new ConnectionFailure("api_status_422 body contains private values"), get = vi.fn().mockRejectedValue(error);
    const reader = createObservedReader({ get }, Date.now() + 2000);
    await expect(reader.get("/api/issues/owned")).rejects.toBe(error);
    expect(reader.failures).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("keeps a shorter phase deadline when that phase begins", async () => {
    vi.useFakeTimers(); let deadlineAt = Date.now() + 100;
    const get = vi.fn().mockRejectedValue(new ConnectionFailure("api_status_504"));
    const reader = createObservedReader({ get }, () => deadlineAt), result = reader.get("/api/issues/owned");
    const assertion = expect(result).rejects.toMatchObject({ code: "observation_read_deadline" });
    await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("fails at the original deadline instead of turning missing observations into a pass", async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValue(new ConnectionFailure("api_status_503"));
    const reader = createObservedReader({ get }, Date.now() + 500), result = reader.get("/api/issues/owned");
    const assertion = expect(result).rejects.toMatchObject({ code: "observation_read_deadline" });
    await vi.advanceTimersByTimeAsync(500); await assertion;
    expect(get).toHaveBeenCalledTimes(1); expect(reader.failures).toHaveLength(1);
  });
});
