import { antigravityApiKeyModels } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ managed: vi.fn(), discover: vi.fn(), cleanup: vi.fn(),
  warn: vi.fn(),
  CleanupError: class extends Error {
    constructor(readonly retired: Promise<void>) { super("cleanup pending"); }
  },
}));
const spawned = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const record = (name: string) => (...args: unknown[]) => { spawned(name); return (actual as never as Record<string, (...a: unknown[]) => unknown>)[name]!(...args); };
  return { ...actual, spawn: record("spawn"), execFile: record("execFile"), fork: record("fork"), exec: record("exec") };
});
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
  void reconcileRetainedGoogleCleanup(scope).catch(() => undefined);
  return {
  attribution: { method: "subscription" }, config: { env: { GEMINI_HOME: "/private/selected-google-home" } },
  cleanup: () => mocks.cleanup(), retainedCleanupScope: scope,
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

it("returns the pinned API-key catalog for a Gemini API key without preparing a credential or starting a process", async () => {
  const models = await antigravityConnectionModels({} as never, { ...input, binding: { provider: "google", method: "api_key", mode: "responsible_user" } });
  expect(models.map(model => model.id)).toEqual(antigravityApiKeyModels().map(model => model.id));
  expect(models.slice(0, 14).map(model => model.id)).toContain("gemini-3.8-flash-high");
  expect(models.find(model => model.id === "gemini-4-neon-high")?.label).toBe("Gemini 4 Neon (High) · needs a paid Gemini API plan");
  expect(mocks.managed).not.toHaveBeenCalled();
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(spawned).not.toHaveBeenCalled();
});

it("answers a sign-in binding that resolves to a Gemini API key with the API-key catalog, never a dead end", async () => {
  mocks.managed.mockResolvedValue({ attribution: { method: "api_key" }, config: { env: { GEMINI_HOME: "/private/home" } }, cleanup: mocks.cleanup });
  const models = await antigravityConnectionModels({} as never, input);
  expect(models).toEqual(antigravityApiKeyModels());
  expect(JSON.stringify(models)).not.toContain("exact model identifier");
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
});

it("does not disguise an absent private home as Google subscription discovery", async () => {
  mocks.managed.mockResolvedValue({ attribution: { method: "subscription" }, config: { env: {} }, cleanup: mocks.cleanup });
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow(/Google/);
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);
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

it("retries the original failed journal cleanup independently of model discovery", async () => {
  const order: string[] = [];
  mocks.discover.mockImplementation(async () => { order.push("provider"); return { models: [] }; });
  mocks.cleanup.mockImplementationOnce(async () => { order.push("journal-failed"); throw new Error("storage unavailable"); })
    .mockImplementation(async () => { order.push("journal-saved"); });
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  await expect(antigravityConnectionModels({} as never, input)).resolves.toEqual([]);
  expect(order.filter(step => step === "provider")).toHaveLength(2);
  expect(order.filter(step => step === "journal-saved")).toHaveLength(2);
});

it("allows another provider launch while the original cleanup still cannot journal", async () => {
  mocks.discover.mockResolvedValue({ models: [] });
  mocks.cleanup.mockRejectedValue(new Error("storage unavailable"));
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  await expect(antigravityConnectionModels({} as never, input)).rejects.toThrow("Could not complete Google account credential cleanup");
  expect(mocks.discover).toHaveBeenCalledTimes(2);
  expect(mocks.cleanup).toHaveBeenCalledTimes(3);
});
