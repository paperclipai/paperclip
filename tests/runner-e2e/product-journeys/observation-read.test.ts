import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionFailure } from "../connection-config.js";
import { createObservedReader } from "./observation-read.js";

afterEach(() => vi.useRealTimers());
describe("bounded observation reads", () => {
  it.each(["api_request_failed", "api_status_408", "api_status_429", "api_status_502", "api_status_503", "api_status_504"])("retains and retries %s without replaying work", async code => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValueOnce(new ConnectionFailure(code)).mockResolvedValue({ id: "owned" });
    const reader = createObservedReader({ get }, Date.now() + 2000), result = reader.get("/api/issues/owned");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ id: "owned" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(reader.failures).toEqual([{ route: "/api/issues/owned", code }]);
  });
  it.each(["api_status_401", "api_status_403", "api_status_404", "api_status_409", "api_status_500", "invalid_api_route"])("preserves %s as a failure", async code => {
    const error = new ConnectionFailure(code), get = vi.fn().mockRejectedValue(error);
    await expect(createObservedReader({ get }, Date.now() + 2000).get("/api/issues/owned")).rejects.toBe(error);
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
