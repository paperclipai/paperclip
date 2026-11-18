import type { Db } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { chatCredentialMutationLease } from "./chat-credential-mutation-lease.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("backs off lease retries while preserving the ten-second wait bound", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T00:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  const returning = vi.fn().mockResolvedValue([]);
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning })) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
  }));
  const db = { insert, update } as unknown as Db;
  const withLease = chatCredentialMutationLease(db);
  let settled = false;
  const pending = withLease({ id: "endpoint", companyId: "company" } as never, async () => undefined)
    .catch(error => {
      settled = true;
      return error;
    });

  await vi.advanceTimersByTimeAsync(1_000);
  expect(insert.mock.calls.length).toBeLessThan(12);

  await vi.advanceTimersByTimeAsync(8_999);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ details: { code: "chat_endpoint_credentials_busy" } });
  expect(settled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
