import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  credential: vi.fn(),
  refresh: vi.fn(),
  codex: vi.fn(),
  claude: vi.fn(),
  adapters: vi.fn(),
}));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({
    quotaAccounts: mocks.accounts,
    credential: mocks.credential,
    refreshQuotaCredential: mocks.refresh,
  }),
}));
vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: mocks.adapters,
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  fetchCodexQuota: mocks.codex,
}));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  fetchClaudeQuota: mocks.claude,
}));
import { fetchCompanyQuotaWindows } from "../services/quota-windows.js";

let revision = 1;
const db = {
  select: () => ({
    from: () => ({
      leftJoin: () => ({
      leftJoin: () => ({
      where: async () => [
        {
          id: "secret",
          updatedAt: new Date(0),
          latestVersion: revision,
          status: "active",
        },
      ],
      }),
      }),
    }),
  }),
} as unknown as Db;
const account = (id: string, provider = "openai", status = "connected") => ({
  connection: { id, updatedAt: new Date(0) },
  grant: {
    id,
    updatedAt: new Date(0),
    credentialSecretRefs: [{ secretId: "secret" }],
  },
  summary: { provider, name: id, status },
});
describe("connected account quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revision = 1;
    mocks.refresh.mockRejectedValue(new Error("authentication_required"));
    mocks.credential.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: "private-token", account_id: "actual-account" },
      }),
    );
    mocks.codex.mockResolvedValue([
      { label: "5h", usedPercent: 0.5, resetsAt: null, valueLabel: null },
    ]);
  });
  afterEach(() => vi.useRealTimers());
  it("uses the selected account without invoking a local CLI or fallback login", async () => {
    mocks.accounts.mockResolvedValue([account("remote-codex")]);
    const result = await fetchCompanyQuotaWindows(db, "company-1", "user-1");
    expect(mocks.accounts).toHaveBeenCalledWith("company-1", "user-1");
    expect(mocks.codex).toHaveBeenCalledWith("private-token", "actual-account", expect.any(AbortSignal));
    expect(mocks.adapters).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      ok: true,
      accountLabel: "remote-codex",
      source: "managed-connection",
    });
    expect(result[0].capturedAt).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("deduplicates account requests and invalidates on credential revision", async () => {
    mocks.accounts.mockResolvedValue([account("cached-codex")]);
    const [a, b] = await Promise.all([
      fetchCompanyQuotaWindows(db, "company-2", "user-2"),
      fetchCompanyQuotaWindows(db, "company-2", "user-2"),
    ]);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(a[0].capturedAt).toBe(b[0].capturedAt);
    revision++;
    const next = await fetchCompanyQuotaWindows(db, "company-2", "user-2");
    expect(mocks.codex).toHaveBeenCalledTimes(2);
    expect(next[0].accountKey).not.toBe(a[0].accountKey);
  });
  it("keeps two accounts for the same provider separate", async () => {
    mocks.accounts.mockResolvedValue([account("first"), account("second")]);
    const result = await fetchCompanyQuotaWindows(db, "company-3", "user-3");
    expect(result).toHaveLength(2);
    expect(result[0].accountKey).not.toBe(result[1].accountKey);
  });
  it("does not expose failures and marks authentication failures for stale-window removal", async () => {
    mocks.accounts.mockResolvedValue([account("expired")]);
    mocks.codex.mockRejectedValue(
      new Error("401 private-token raw provider diagnostics"),
    );
    const [result] = await fetchCompanyQuotaWindows(db, "company-4", "user-4");
    expect(result.errorFamily).toBe("authentication_required");
    expect(result.windows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("does not read revoked credentials or use the server login for an unconnected remote account", async () => {
    mocks.accounts.mockResolvedValue([account("revoked", "openai", "revoked")]);
    const [result] = await fetchCompanyQuotaWindows(db, "company-5", "user-5");
    expect(result.errorFamily).toBe("credentials_unavailable");
    expect(mocks.credential).not.toHaveBeenCalled();
    mocks.accounts.mockResolvedValue([]);
    const empty = await fetchCompanyQuotaWindows(db, "company-5", "user-5");
    expect(
      empty.every((row) => row.errorFamily === "credentials_unavailable"),
    ).toBe(true);
    expect(mocks.adapters).not.toHaveBeenCalled();
  });
  it("uses a managed Claude OAuth credential and keeps failed reads private", async () => {
    mocks.accounts.mockResolvedValue([account("claude-account", "anthropic")]);
    mocks.credential.mockResolvedValue("claude-private-oauth");
    mocks.claude.mockResolvedValue([
      { label: "Weekly", usedPercent: 12, resetsAt: null, valueLabel: null },
    ]);
    const [result] = await fetchCompanyQuotaWindows(db, "company-6", "user-6");
    expect(result.ok).toBe(true);
    expect(mocks.claude).toHaveBeenCalledWith("claude-private-oauth", expect.any(AbortSignal));
    mocks.accounts.mockResolvedValue([account("secret-failure")]);
    mocks.credential.mockRejectedValue(
      new Error("private credential store failure"),
    );
    const [failed] = await fetchCompanyQuotaWindows(db, "company-6", "user-6");
    expect(failed.errorFamily).toBe("provider_unavailable");
    expect(JSON.stringify(failed)).not.toContain("private credential");
  });
  it("reads quota for a verified login without an optional account ID", async () => {
    mocks.accounts.mockResolvedValue([account("missing-identity")]);
    mocks.credential.mockResolvedValue(
      JSON.stringify({ accessToken: "private" }),
    );
    const [result] = await fetchCompanyQuotaWindows(db, "company-7", "user-7");
    expect(result.ok).toBe(true);
    expect(mocks.codex).toHaveBeenCalledWith("private", null, expect.any(AbortSignal));
  });
  it("distinguishes permission errors from revoked credentials", async () => {
    mocks.accounts.mockResolvedValue([account("permission-error")]);
    mocks.codex.mockRejectedValueOnce(new Error("chatgpt wham api returned 403"));
    const [result] = await fetchCompanyQuotaWindows(db, "permission-company", "user");
    expect(result.errorFamily).toBe("permission_denied");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("refreshes an expired selected credential once before retrying quota", async () => {
    mocks.accounts.mockResolvedValue([account("refresh-account")]);
    mocks.codex.mockRejectedValueOnce(new Error("chatgpt wham api returned 401"));
    mocks.refresh.mockImplementationOnce(async () => {
      const value = JSON.stringify({ tokens: { access_token: "new-token", account_id: "same-account" } });
      revision++;
      mocks.credential.mockResolvedValue(value);
      return value;
    });
    const [result] = await fetchCompanyQuotaWindows(db, "refresh-company", "user");
    expect(result.ok).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.codex).toHaveBeenLastCalledWith("new-token", "same-account", expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("new-token");
    const again = await fetchCompanyQuotaWindows(db, "refresh-company", "user");
    expect(again[0]).toEqual(result);
    expect(mocks.codex).toHaveBeenCalledTimes(2); // initial 401 and one refreshed read

  });
  it("does not cache a quota read under a credential revision that changed during resolution", async () => {
    mocks.accounts.mockResolvedValue([account("rotating-during-refresh")]);
    mocks.codex.mockRejectedValueOnce(new Error("401"));
    mocks.refresh.mockResolvedValue(JSON.stringify({ accessToken: "refreshed" }));
    mocks.credential.mockResolvedValueOnce(JSON.stringify({ accessToken: "expired" })).mockImplementationOnce(async () => {
      revision++;
      return JSON.stringify({ accessToken: "changed-again" });
    });
    const [result] = await fetchCompanyQuotaWindows(db, "changing-revision", "user");
    expect(result).toMatchObject({ ok: false, errorFamily: "provider_unavailable" });
    expect(mocks.codex).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled credential lookup and preserves its account identity", async () => {
    vi.useFakeTimers();
    mocks.accounts.mockResolvedValue([account("stalled")]);
    mocks.credential.mockReturnValue(new Promise(() => {}));
    const pending = fetchCompanyQuotaWindows(db, "company-8", "user-8");
    await vi.advanceTimersByTimeAsync(20_001);
    const [result] = await pending;
    expect(result).toMatchObject({
      ok: false,
      accountLabel: "stalled",
      windows: [],
    });
    expect(result.accountKey).toBeTruthy();
    expect(result.error).not.toContain("timed out");
  });
  it("does not start a provider request when a credential resolves after its deadline", async () => {
    vi.useFakeTimers();
    mocks.accounts.mockResolvedValue([account("late-credential")]);
    let resolveCredential!: (value: string) => void;
    mocks.credential.mockReturnValue(new Promise<string>((resolve) => { resolveCredential = resolve; }));
    const pending = fetchCompanyQuotaWindows(db, "late-company", "late-user");
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending)[0].ok).toBe(false);
    resolveCredential(JSON.stringify({ accessToken: "private", accountId: "actual" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it("cancels an active provider read when the account deadline expires", async () => {
    vi.useFakeTimers();
    mocks.accounts.mockResolvedValue([account("slow-provider")]);
    let signal!: AbortSignal;
    mocks.codex.mockImplementation((_token, _id, abortSignal) => {
      signal = abortSignal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = fetchCompanyQuotaWindows(db, "slow-company", "slow-user");
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending)[0].ok).toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it("limits account probes to four concurrent requests and preserves account order", async () => {
    mocks.accounts.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => account(`parallel-${i}`)),
    );
    mocks.credential.mockResolvedValue(
      JSON.stringify({ accessToken: "private", accountId: "actual" }),
    );
    let active = 0,
      maximum = 0;
    mocks.codex.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [];
    });
    const results = await fetchCompanyQuotaWindows(db, "company-9", "user-9");
    expect(maximum).toBe(4);
    expect(results.map((row) => row.accountLabel)).toEqual(
      Array.from({ length: 9 }, (_, i) => `parallel-${i}`),
    );
  });
});
