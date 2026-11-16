import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const mocks = vi.hoisted(() => ({ wait: vi.fn(), wizard: vi.fn(), get: vi.fn() }));
vi.mock("./identity-support.js", async original => ({ ...await original<typeof import("./identity-support.js")>(), waitForReply: mocks.wait }));
vi.mock("./identity-new-company-native.js", () => ({ finishNativeNewCompany: mocks.wizard }));
import { newCompanyIdentityCases } from "./identity-new-company.js";
const stop = new Error("Controlled wizard boundary; no browser, account, server or model");
afterEach(() => { vi.useRealTimers(); mocks.wait.mockReset(); mocks.wizard.mockReset(); mocks.get.mockReset(); });
function context(deadline: number | undefined = 570_000) {
  mocks.wizard.mockRejectedValue(stop); mocks.get.mockResolvedValue([{ id: "source-company" }]);
  return { observationDeadlineAt: deadline, input: { nonce: "synthetic-clock", privateInputs: { credentials: { OPENROUTER_API_KEY: "synthetic-never-dispatched-key" } }, privateSecrets: [],
    api: { baseURL: "http://127.0.0.1:1", get: mocks.get }, page: { url: () => "http://127.0.0.1:1/SRC/chat" } } } as unknown as ChatCatalogContext;
}
it("uses the SAME original phase beyond150s and preserves the existing360s human setup maximum", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); mocks.wait.mockResolvedValue(undefined); mocks.wizard.mockRejectedValue(stop);
  await expect(newCompanyIdentityCases[0]!.act!(ctx, {})).rejects.toBe(stop);
  expect(mocks.wait).toHaveBeenCalledExactlyOnceWith(ctx, 570_000);
  expect(mocks.wizard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deadlineAt: 560_000 }));
  expect(newCompanyIdentityCases[0]!.expectedRunCount).toBe(1); expect(newCompanyIdentityCases[0]!.expectedHumanMessageCount ?? 1).toBe(1);
  expect(newCompanyIdentityCases[0]!.attemptTimeoutMs).toBe(600_000);
});
it("caps late human setup at the remaining original phase instead of giving a fresh360s", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); mocks.wait.mockImplementation(async () => { vi.setSystemTime(500_000); }); mocks.wizard.mockRejectedValue(stop);
  await expect(newCompanyIdentityCases[0]!.act!(ctx, {})).rejects.toBe(stop);
  expect(mocks.wait).toHaveBeenCalledExactlyOnceWith(ctx, 570_000);
  expect(mocks.wizard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deadlineAt: 570_000 }));
});
it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 200_000])("rejects missing/nonfinite/exhausted phase before waiting: %s", async deadline => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); (ctx as { observationDeadlineAt?: number }).observationDeadlineAt = deadline;
  await expect(newCompanyIdentityCases[0]!.act!(ctx, {})).rejects.toThrow("Original identity observation budget exhausted or missing");
  expect(mocks.wait).not.toHaveBeenCalled(); expect(mocks.wizard).not.toHaveBeenCalled(); expect(ctx.input.api.get).not.toHaveBeenCalled();
});
it("rechecks the original phase after waiting before any company or human setup action", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(); mocks.wait.mockImplementation(async () => { vi.setSystemTime(570_000); });
  await expect(newCompanyIdentityCases[0]!.act!(ctx, {})).rejects.toThrow("Original identity observation budget exhausted or missing");
  expect(mocks.wizard).not.toHaveBeenCalled(); expect(ctx.input.api.get).not.toHaveBeenCalled();
});

it("does not start human setup if the authenticated company read consumes the remaining phase", async () => {
  vi.useFakeTimers(); vi.setSystemTime(500_000); const ctx = context(); mocks.wait.mockResolvedValue(undefined);
  mocks.get.mockImplementationOnce(async () => { vi.setSystemTime(570_000); return [{ id: "source-company" }]; });
  await expect(newCompanyIdentityCases[0]!.act!(ctx, {})).rejects.toThrow("Original identity observation budget exhausted or missing");
  expect(mocks.wizard).not.toHaveBeenCalled();
});
