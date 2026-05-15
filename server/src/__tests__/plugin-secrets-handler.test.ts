import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getByIdMock = vi.fn();
const resolveSecretValueMock = vi.fn();

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getById: getByIdMock,
    resolveSecretValue: resolveSecretValueMock,
  }),
}));

// Import AFTER the mock so the handler picks up the mocked factory.
const { createPluginSecretsHandler } = await import("../services/plugin-secrets-handler.js");

describe("createPluginSecretsHandler", () => {
  beforeEach(() => {
    getByIdMock.mockReset();
    resolveSecretValueMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed secret refs before touching the secret store", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);

    expect(getByIdMock).not.toHaveBeenCalled();
    expect(resolveSecretValueMock).not.toHaveBeenCalled();
  });

  it("rejects when the secret UUID is not found in the database", async () => {
    getByIdMock.mockResolvedValueOnce(null);

    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toThrow(/invalid secret reference/i);

    expect(getByIdMock).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777");
    expect(resolveSecretValueMock).not.toHaveBeenCalled();
  });

  it("resolves under the secret's owning company when the UUID is known", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    resolveSecretValueMock.mockResolvedValueOnce("xoxb-decrypted-token");

    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    const value = await handler.resolve({
      secretRef: "77777777-7777-4777-8777-777777777777",
    });

    expect(value).toBe("xoxb-decrypted-token");
    expect(resolveSecretValueMock).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "77777777-7777-4777-8777-777777777777",
      "latest",
    );
  });
});
