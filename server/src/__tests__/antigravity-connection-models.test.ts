import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ managed: vi.fn(), discover: vi.fn(), cleanup: vi.fn(),
  warn: vi.fn(),
  CleanupError: class extends Error {
    constructor(readonly retired: Promise<void>) { super("cleanup pending"); }
  },
}));
vi.mock("../services/ai-connection-runtime.js", () => ({ prepareManagedAiRuntime: mocks.managed }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../vendor/paperclip-runner/index.js", () => ({
  discoverAntigravityModels: mocks.discover, AntigravityModelDiscoveryCleanupError: mocks.CleanupError,
}));
import { antigravityConnectionModels } from "../services/antigravity-connection-models.js";
import { RetiredCredentialRecoveryError } from "../services/quota-credential-recovery.js";
import { reconcileRetainedGoogleCleanup } from "../services/retained-google-credential-cleanup.js";

const input = { companyId: "company", userId: "alice", binding: { provider: "google", method: "subscription", mode: "responsible_user" } as const,
  allowUninstalledShared: false };
let sequence = 0;
let scope = { companyId: "company", accountKey: "" };
beforeEach(() => { vi.clearAllMocks(); scope = { companyId: "company", accountKey: `catalog-${++sequence}` }; mocks.cleanup.mockResolvedValue(undefined); mocks.managed.mockImplementation(async () => {
  await reconcileRetainedGoogleCleanup(scope);
  return {
  attribution: { method: "subscription" }, config: { env: { GEMINI_HOME: "/private/selected-google-home" } },
  cleanup: mocks.cleanup, retainedCleanupScope: scope,
}; }); });
afterEach(async () => { vi.useRealTimers(); mocks.cleanup.mockResolvedValue(undefined); await reconcileRetainedGoogleCleanup(scope); });

it("uses the selected account lifecycle and returns only its model catalog", async () => {
  const models = [{ id: "exact-google-model", label: "Google model" }];
  mocks.discover.mockResolvedValue({ models, defaultModelId: "exact-google-model" });
  expect(await antigravityConnectionModels({} as never, input)).toEqual(models);
  expect(mocks.managed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    companyId: "company", responsibleUserId: "alice", adapterType: "paperclip_runner", binding: input.binding,
    allowUninstalledPersonal: true, allowUninstalledShared: false, config: { provider: "acpx", acpxAgent: "antigravity" },
  }));
  expect(mocks.discover).toHaveBeenCalledWith("/private/selected-google-home");
  expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith();
});

it("does not disguise an API key or absent private home as Google subscription discovery", async () => {
  for (const runtime of [{ attribution: { method: "api_key" }, config: { env: { GEMINI_HOME: "/private/home" } } },
    { attribution: { method: "subscription" }, config: { env: {} } }]) {
    mocks.managed.mockResolvedValue({ ...runtime, cleanup: mocks.cleanup });
    await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow(/Google|model identifier/);
  }
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledTimes(2);
});

it("preserves account-resolution denial and sanitizes native discovery errors", async () => {
  mocks.managed.mockRejectedValueOnce(new Error("membership denied"));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("membership denied");
  expect(mocks.cleanup).not.toHaveBeenCalled();
  mocks.discover.mockRejectedValueOnce(new Error("provider-private-text"));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not load models");
  expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith();
});

it("retains the selected credential home until uncertain native cleanup proves retirement", async () => {
  let retire!: () => void;
  const retired = new Promise<void>((resolve) => { retire = resolve; });
  mocks.discover.mockRejectedValueOnce(new mocks.CleanupError(retired));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not load models");
  expect(mocks.cleanup).not.toHaveBeenCalled();
  retire();
  await retired;
  await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith());
});

it.each(["success", "failure"])("retains storage failure after native discovery %s without background database retries", async outcome => {
  vi.useFakeTimers();
  if (outcome === "success") mocks.discover.mockResolvedValue({ models: [{ id: "exact-model", label: "Model" }] });
  else mocks.discover.mockRejectedValue(new Error("private-provider-token"));
  mocks.cleanup.mockRejectedValueOnce(new Error("private-provider-token database write failure"));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  expect(mocks.managed).toHaveBeenCalledTimes(1);
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith({ companyId: "company", code: "ANTIGRAVITY_CATALOG_CREDENTIAL_CLEANUP_PENDING" },
    "Antigravity model-discovery credential cleanup is retained for recovery");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for native retirement, then lets the durable journal own failed writeback without a retry loop", async () => {
  vi.useFakeTimers();
  let retire!: () => void;
  const retired = new Promise<void>(resolve => { retire = resolve; });
  mocks.discover.mockRejectedValueOnce(new mocks.CleanupError(retired));
  mocks.cleanup.mockRejectedValueOnce(new RetiredCredentialRecoveryError(new Error("private-token first failure")));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not load models");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(mocks.cleanup).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  retire();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(mocks.managed).toHaveBeenCalledTimes(1);
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private-token");
});

it("settles the original failed journal cleanup before retrying model discovery", async () => {
  const order: string[] = [];
  mocks.discover.mockImplementation(async () => { order.push("provider"); return { models: [] }; });
  mocks.cleanup.mockImplementationOnce(async () => { order.push("journal-failed"); throw new Error("storage unavailable"); })
    .mockImplementation(async () => { order.push("journal-saved"); });
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  await expect(antigravityConnectionModels({} as never, input)).resolves.toEqual([]);
  expect(order).toEqual(["provider", "journal-failed", "journal-saved", "provider", "journal-saved"]);
});

it("blocks another provider launch while the original cleanup still cannot journal", async () => {
  mocks.discover.mockResolvedValue({ models: [] });
  mocks.cleanup.mockRejectedValue(new Error("storage unavailable"));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("still completing credential cleanup");
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  expect(mocks.cleanup).toHaveBeenCalledTimes(2);
});
