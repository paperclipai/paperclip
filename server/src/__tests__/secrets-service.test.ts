import { describe, expect, it, vi, beforeEach } from "vitest";

const mockResolveVersion = vi.hoisted(() => vi.fn());

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn(() => ({
    resolveVersion: mockResolveVersion,
  })),
  listSecretProviders: vi.fn(() => []),
}));

import { secretService } from "../services/secrets.ts";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb(selectResults: unknown[][] = []) {
  return {
    select: vi.fn(() => createSelectChain(selectResults.shift() ?? [])),
  } as any;
}

describe("secretService.resolveAdapterConfigForRuntime", () => {
  const secretId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveVersion.mockResolvedValue("resolved-token");
  });

  it("materializes authTokenRef into authToken and removes the ref from runtime config", async () => {
    const db = createDb([
      [
        {
          id: secretId,
          companyId: "company-1",
          latestVersion: 7,
          provider: "local_encrypted",
          externalRef: null,
        },
      ],
      [
        {
          id: secretId,
          companyId: "company-1",
          latestVersion: 7,
          provider: "local_encrypted",
          externalRef: null,
        },
      ],
      [
        {
          secretId,
          version: 7,
          material: { encrypted: "ciphertext" },
        },
      ],
    ]);
    const secrets = secretService(db);

    const result = await secrets.resolveAdapterConfigForRuntime("company-1", {
      authTokenRef: { type: "secret_ref", secretId, version: "latest" },
    });

    expect(result.config).toEqual({
      authToken: "resolved-token",
    });
    expect(result.config).not.toHaveProperty("authTokenRef");
    expect(Array.from(result.secretKeys)).toEqual(["authToken"]);
  });

  it("does not resolve authTokenRef when plaintext authToken is already present", async () => {
    const authTokenRef = { type: "secret_ref", secretId, version: "latest" } as const;
    const db = createDb();
    const secrets = secretService(db);

    const result = await secrets.resolveAdapterConfigForRuntime("company-1", {
      authToken: "plaintext-token",
      authTokenRef,
    });

    expect(result.config).toEqual({
      authToken: "plaintext-token",
      authTokenRef,
    });
    expect(Array.from(result.secretKeys)).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(mockResolveVersion).not.toHaveBeenCalled();
  });

  it("materializes apiKeyRef into apiKey and removes the ref from runtime config", async () => {
    const db = createDb([
      [
        {
          id: secretId,
          companyId: "company-1",
          latestVersion: 7,
          provider: "local_encrypted",
          externalRef: null,
        },
      ],
      [
        {
          id: secretId,
          companyId: "company-1",
          latestVersion: 7,
          provider: "local_encrypted",
          externalRef: null,
        },
      ],
      [
        {
          secretId,
          version: 7,
          material: { encrypted: "ciphertext" },
        },
      ],
    ]);
    const secrets = secretService(db);

    const result = await secrets.resolveAdapterConfigForRuntime("company-1", {
      apiKeyRef: { type: "secret_ref", secretId, version: "latest" },
    });

    expect(result.config).toEqual({
      apiKey: "resolved-token",
    });
    expect(result.config).not.toHaveProperty("apiKeyRef");
    expect(Array.from(result.secretKeys)).toEqual(["apiKey"]);
  });
});
