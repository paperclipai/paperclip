import { afterEach, expect, it, vi } from "vitest";
import { retryChatControlAdmission } from "./chat-control-admission-retry.js";

afterEach(() => vi.useRealTimers());

it("retries a rolled-back lock conflict and returns the fresh admission result", async () => {
  vi.useFakeTimers();
  const attempt = vi.fn()
    .mockRejectedValueOnce(new Error("query failed", { cause: { code: "55P03" } }))
    .mockResolvedValueOnce(null);
  const result = retryChatControlAdmission(attempt);
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toBeNull();
  expect(attempt).toHaveBeenCalledTimes(2);
});

it("does not retry unrelated database failures", async () => {
  const error = new Error("constraint violation", { cause: { code: "23505" } });
  const attempt = vi.fn().mockRejectedValue(error);
  await expect(retryChatControlAdmission(attempt)).rejects.toBe(error);
  expect(attempt).toHaveBeenCalledTimes(1);
});

it("stops persistent contention after fifty delays", async () => {
  vi.useFakeTimers();
  const error = new Error("query failed", { cause: { code: "55P03" } });
  const attempt = vi.fn().mockRejectedValue(error);
  const rejected = expect(retryChatControlAdmission(attempt)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect(attempt).toHaveBeenCalledTimes(51);
  expect(vi.getTimerCount()).toBe(0);
});
