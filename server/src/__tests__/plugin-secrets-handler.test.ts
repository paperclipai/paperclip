import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";

const mockResolveSecretValue = vi.fn();

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

describe("createPluginSecretsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves secret refs only with explicit company scope", async () => {
    mockResolveSecretValue.mockResolvedValue("resolved-token");
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({
        companyId: "22222222-2222-4222-8222-222222222222",
        secretRef: "77777777-7777-4777-8777-777777777777",
      }),
    ).resolves.toBe("resolved-token");

    expect(mockResolveSecretValue).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "77777777-7777-4777-8777-777777777777",
      "latest",
      { consumerType: "plugin", consumerId: "11111111-1111-4111-8111-111111111111" },
    );
  });

  it("fails closed when company scope is missing", async () => {
    const handler = createPluginSecretsHandler({
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
            })),
          })),
        })),
      } as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" } as never),
    ).rejects.toThrow(/companyId is required/i);
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
  });

  it("still rejects malformed secret refs before the feature-disable guard", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ companyId: "22222222-2222-4222-8222-222222222222", secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});
