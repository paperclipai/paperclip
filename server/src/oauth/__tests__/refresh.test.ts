import { describe, it, expect, vi } from "vitest";
import { refreshConnection } from "../refresh.js";

interface FakeRow {
  id: string;
  companyId: string;
  providerId: string;
  status: string;
  scopes: string[];
  accountId: string | null;
  accessTokenSecretId: string;
  refreshTokenSecretId: string | null;
  accessTokenExpiresAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  refreshAttemptCount: number;
}

const fakeRow = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  id: "conn-1",
  companyId: "c1",
  providerId: "github",
  status: "active",
  scopes: ["repo"],
  accountId: "acct-42",
  accessTokenSecretId: "s-access",
  refreshTokenSecretId: "s-refresh",
  accessTokenExpiresAt: new Date(Date.now() + 30_000),
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
  ...overrides,
});

const fakeProvider = (rotates = false) => ({
  config: {
    id: "github",
    endpoints: { token: "https://x/t", accountInfo: "https://x/me" },
    authMethod: "post" as const,
    responseFormat: "json" as const,
    accountIdField: "id",
    accountLabelField: "login",
    refresh: { supported: true, rotatesRefreshToken: rotates },
  },
  clientId: "id",
  clientSecret: "sec",
  shape: {
    parseTokenResponse: (r: Record<string, unknown>) => ({
      accessToken: r.access_token as string,
      refreshToken:
        typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresInSeconds:
        typeof r.expires_in === "number" ? r.expires_in : undefined,
      scope: typeof r.scope === "string" ? r.scope.split(" ") : undefined,
    }),
  },
});

function makeTxDb(row: FakeRow, capture: { update?: any } = {}) {
  const tx = {
    query: {
      oauthConnections: {
        findFirst: vi.fn().mockResolvedValue(row),
      },
    },
    update: () => ({
      set: (v: unknown) => ({
        where: () => {
          // Last write wins — refresh.ts only issues one update per call path.
          capture.update = v;
          return Promise.resolve();
        },
      }),
    }),
  };
  return {
    transaction: async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx),
  };
}

describe("refreshConnection", () => {
  it("rotates access token + persists new version on success", async () => {
    const captured: { update?: any } = {};
    const upsertSecretByName = vi
      .fn()
      .mockImplementation(async (_companyId: string, input: { name: string }) =>
        input.name.endsWith(":access")
          ? { id: "new-access" }
          : { id: "new-refresh" },
      );
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(fakeRow(), captured) as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        resolveSecretValue: async () => "OLD_REFRESH",
        upsertSecretByName,
      },
      exchangeFn: async () => ({
        access_token: "NEW_ACCESS",
        expires_in: 3600,
        scope: "repo",
      }),
    });
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.accessToken).toBe("NEW_ACCESS");
    }
    expect(upsertSecretByName).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        name: "oauth:github:acct-42:access",
        value: "NEW_ACCESS",
      }),
    );
    expect(captured.update).toMatchObject({
      status: "active",
      accessTokenSecretId: "new-access",
      refreshAttemptCount: 0,
      lastError: null,
    });
  });

  it("uses connectionId in secret name when accountId is null", async () => {
    const upsertSecretByName = vi
      .fn()
      .mockResolvedValue({ id: "new-access" });
    await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(fakeRow({ accountId: null })) as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        resolveSecretValue: async () => "OLD_REFRESH",
        upsertSecretByName,
      },
      exchangeFn: async () => ({ access_token: "A", expires_in: 60 }),
    });
    expect(upsertSecretByName).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ name: "oauth:github:conn-1:access" }),
    );
  });

  it("flips status to revoked on invalid_grant (duck-typed)", async () => {
    const captured: { update?: any } = {};
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(fakeRow(), captured) as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        resolveSecretValue: async () => "x",
        upsertSecretByName: vi.fn(),
      },
      exchangeFn: async () => {
        const e = new Error("invalid_grant") as Error & {
          status?: number;
          providerErrorCode?: string;
        };
        e.status = 400;
        e.providerErrorCode = "invalid_grant";
        throw e;
      },
    });
    expect(result.outcome).toBe("revoked");
    expect(captured.update).toMatchObject({
      status: "revoked",
      lastError: "invalid_grant",
    });
  });

  it("returns transient on non-permanent errors and bumps attempt count", async () => {
    const captured: { update?: any } = {};
    const startRow = fakeRow({ refreshAttemptCount: 2 });
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(startRow, captured) as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        resolveSecretValue: async () => "x",
        upsertSecretByName: vi.fn(),
      },
      exchangeFn: async () => {
        const e = new Error("network down") as Error & { status?: number };
        e.status = 502;
        throw e;
      },
    });
    expect(result.outcome).toBe("transient");
    expect(captured.update).toMatchObject({
      lastError: "network down",
      refreshAttemptCount: 3,
    });
  });

  it("rotates refresh token when provider returns one", async () => {
    const captured: { update?: any } = {};
    const upsertSecretByName = vi
      .fn()
      .mockImplementationOnce(async () => ({ id: "new-access" }))
      .mockImplementationOnce(async () => ({ id: "new-refresh" }));
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(fakeRow(), captured) as any,
      registry: { get: () => fakeProvider(true) } as any,
      secretService: {
        resolveSecretValue: async () => "OLD_REFRESH",
        upsertSecretByName,
      },
      exchangeFn: async () => ({
        access_token: "NEW_ACCESS",
        refresh_token: "NEW_REFRESH",
        expires_in: 3600,
      }),
    });
    expect(result.outcome).toBe("success");
    expect(upsertSecretByName).toHaveBeenCalledTimes(2);
    expect(captured.update).toMatchObject({
      accessTokenSecretId: "new-access",
      refreshTokenSecretId: "new-refresh",
    });
  });

  it("skips when row has no refresh token secret", async () => {
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: makeTxDb(fakeRow({ refreshTokenSecretId: null })) as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        resolveSecretValue: async () => "x",
        upsertSecretByName: vi.fn(),
      },
      exchangeFn: async () => ({ access_token: "a" }),
    });
    expect(result.outcome).toBe("skipped");
    if (result.outcome === "skipped") {
      expect(result.reason).toBe("no_refresh_token");
    }
  });
});
