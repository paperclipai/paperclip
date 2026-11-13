import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const mocks = vi.hoisted(() => ({ wait: vi.fn() }));
vi.mock("./identity-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./identity-support.js")>(), waitForReply: mocks.wait }));
import { hireRevisionIdentityCases } from "./identity-hire-revision.js";
afterEach(() => { vi.useRealTimers(); mocks.wait.mockReset(); });
it("passes the original remaining observation deadline after the incidental150s window without adding time", async () => {
  vi.useFakeTimers(); vi.setSystemTime(190_000);
  const ctx = { observationDeadlineAt: 270_000 } as ChatCatalogContext;
  const stop = new Error("Controlled wait boundary; no UI or API action"); mocks.wait.mockRejectedValue(stop);
  await expect(hireRevisionIdentityCases[0]!.act!(ctx, {})).rejects.toBe(stop);
  expect(mocks.wait).toHaveBeenCalledExactlyOnceWith(ctx, 270_000);
  expect(hireRevisionIdentityCases[0]!.attemptTimeoutMs).toBe(300_000);
});
it.each([undefined, Number.NaN, 190_000])("rejects missing or exhausted original clock before waiting: %s", async deadline => {
  vi.useFakeTimers(); vi.setSystemTime(190_000);
  const ctx = { observationDeadlineAt: deadline } as ChatCatalogContext;
  mocks.wait.mockRejectedValue(new Error("Must not reach wait"));
  await expect(hireRevisionIdentityCases[0]!.act!(ctx, {})).rejects.toThrow("Original identity observation budget exhausted or missing");
  expect(mocks.wait).not.toHaveBeenCalled();
});
