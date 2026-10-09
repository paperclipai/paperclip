import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  credential: vi.fn(),
  refresh: vi.fn(),
  catalog: vi.fn(),
  version: vi.fn(),
}));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({
    quotaAccounts: mocks.accounts,
    credential: mocks.credential,
    refreshQuotaCredential: mocks.refresh,
  }),
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  fetchCodexModelCatalog: mocks.catalog,
  readCodexCommandVersion: mocks.version,
}));
import {
  codexSubscriptionModelsCacheSizeForTests,
  listCodexSubscriptionModels,
  resetCodexSubscriptionModelsCacheForTests,
} from "../services/codex-subscription-models.js";

const db = {} as Db;
const account = (id: string, provider = "openai", status = "connected") => ({
  connection: { id, updatedAt: new Date(0) },
  grant: { id, updatedAt: new Date(0), credentialSecretRefs: [{ secretId: `secret-${id}` }] },
  summary: { provider, name: id, status },
});
const subscription = (accessToken: string) =>
  JSON.stringify({ tokens: { access_token: accessToken, account_id: "account" } });

describe("Codex subscription model catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodexSubscriptionModelsCacheForTests();
    mocks.version.mockResolvedValue("0.161.0");
    mocks.credential.mockResolvedValue(subscription("access"));
    mocks.catalog.mockResolvedValue([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
  });

  it("lists the connected subscription's catalog at the installed Codex version", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    await expect(listCodexSubscriptionModels(db, "company", "user"))
      .resolves.toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
    expect(mocks.catalog).toHaveBeenCalledWith({
      accessToken: "access", accountId: "account", clientVersion: "0.161.0", signal: expect.any(AbortSignal),
    });
    expect(mocks.version).toHaveBeenCalledWith(expect.objectContaining({ command: "codex", target: null }));
  });

  it("keeps the static list without a connected ChatGPT subscription or a known CLI version", async () => {
    mocks.accounts.mockResolvedValue([account("claude", "anthropic"), account("stale", "openai", "reconnect_required")]);
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([]);
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.version.mockResolvedValue(null);
    await expect(listCodexSubscriptionModels(db, "company", "user", { refresh: true })).resolves.toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("refreshes an expired token once, then retries", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.catalog.mockRejectedValueOnce(new Error("chatgpt codex models api returned 401"));
    mocks.refresh.mockResolvedValue(subscription("fresh"));
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ grant: expect.objectContaining({ id: "chatgpt" }) }), subscription("access"), expect.any(AbortSignal));
    expect(mocks.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: "fresh" }));
  });

  it("falls back quietly when the backend fails, and does not cache the failure", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.catalog.mockRejectedValueOnce(new Error("chatgpt codex models api returned 503"));
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([]);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toHaveLength(1);
  });

  it("caches per account and skips the cache on Refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.accounts.mockResolvedValue([account("chatgpt")]);
      await listCodexSubscriptionModels(db, "company", "user");
      await listCodexSubscriptionModels(db, "company", "user");
      expect(mocks.catalog).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      await listCodexSubscriptionModels(db, "company", "user", { refresh: true });
      expect(mocks.catalog).toHaveBeenCalledTimes(2);
      expect(mocks.version).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start new probes for repeated Refresh calls", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    await listCodexSubscriptionModels(db, "company", "user", { refresh: true });
    await listCodexSubscriptionModels(db, "company", "user", { refresh: true });
    await Promise.all(Array.from({ length: 5 }, () => listCodexSubscriptionModels(db, "company", "user", { refresh: true })));
    expect(mocks.version).toHaveBeenCalledTimes(1);
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });

  it("shares a lookup in flight with concurrent Refresh calls", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    let finishVersion!: (version: string) => void;
    mocks.version.mockReturnValueOnce(new Promise((resolve) => { finishVersion = resolve; }));
    const first = listCodexSubscriptionModels(db, "company", "user");
    const refreshes = Array.from({ length: 5 }, () => listCodexSubscriptionModels(db, "company", "user", { refresh: true }));
    await vi.waitFor(() => expect(mocks.version).toHaveBeenCalledTimes(1));
    finishVersion("0.161.0");
    for (const result of await Promise.all([first, ...refreshes])) expect(result).toHaveLength(1);
    expect(mocks.version).toHaveBeenCalledTimes(1);
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });

  it("reads at most four accounts at a time", async () => {
    mocks.accounts.mockResolvedValue(Array.from({ length: 10 }, (_, index) => account(`account-${index}`)));
    mocks.catalog.mockReturnValue(new Promise(() => {}));
    await expect(listCodexSubscriptionModels(db, "company", "user", { budgetMs: 50 })).resolves.toEqual([]);
    expect(mocks.catalog).toHaveBeenCalledTimes(4);
  });

  it("cancels an account lookup after its own deadline, even past the picker's budget", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.catalog.mockReturnValue(new Promise(() => {}));
    await expect(listCodexSubscriptionModels(db, "company", "user", { budgetMs: 20, accountTimeoutMs: 200 }))
      .resolves.toEqual([]);
    const { signal } = mocks.catalog.mock.calls[0][0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("merges several subscriptions without duplicates", async () => {
    mocks.accounts.mockResolvedValue([account("plus"), account("pro")]);
    mocks.catalog
      .mockResolvedValueOnce([{ id: "gpt-6-sol", label: "GPT-6-Sol" }])
      .mockResolvedValueOnce([{ id: "gpt-6-sol", label: "GPT-6-Sol" }, { id: "gpt-6-astra", label: "GPT-6-Astra" }]);
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
    ]);
  });

  it("never fails the model picker", async () => {
    mocks.accounts.mockRejectedValue(new Error("database unavailable"));
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([]);
  });

  it("returns the static list when the lookup outlasts its budget", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.version.mockReturnValue(new Promise(() => {}));
    await expect(listCodexSubscriptionModels(db, "company", "user", { budgetMs: 20 })).resolves.toEqual([]);
  });

  it("retries a failed lookup that a Refresh shared", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    let failSlowRequest!: (error: Error) => void;
    mocks.catalog.mockReturnValueOnce(new Promise((_resolve, reject) => { failSlowRequest = reject; }));
    const slow = listCodexSubscriptionModels(db, "company", "user");
    await vi.waitFor(() => expect(mocks.catalog).toHaveBeenCalledTimes(1));
    const refresh = listCodexSubscriptionModels(db, "company", "user", { refresh: true });
    failSlowRequest(new Error("chatgpt codex models api returned 503"));
    await expect(Promise.all([slow, refresh])).resolves.toEqual([[], []]);
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toHaveLength(1);
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
  });

  describe("cache bounds", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("drops expired catalogs of accounts that are gone", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      mocks.accounts.mockResolvedValue([account("old")]);
      await listCodexSubscriptionModels(db, "company", "user");
      expect(codexSubscriptionModelsCacheSizeForTests()).toBe(1);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      mocks.accounts.mockResolvedValue([account("reconnected")]);
      await listCodexSubscriptionModels(db, "company", "user");
      expect(codexSubscriptionModelsCacheSizeForTests()).toBe(1);
    });

    it("never holds more than 256 catalogs, even within one lookup", async () => {
      mocks.accounts.mockResolvedValue(Array.from({ length: 300 }, (_, index) => account(`account-${index}`)));
      await listCodexSubscriptionModels(db, "company", "user");
      expect(codexSubscriptionModelsCacheSizeForTests()).toBe(256);
      // The oldest entries went out first: the newest account is still cached.
      mocks.accounts.mockResolvedValue([account("account-299")]);
      mocks.catalog.mockClear();
      await listCodexSubscriptionModels(db, "company", "user");
      expect(mocks.catalog).not.toHaveBeenCalled();
    });
  });
});
