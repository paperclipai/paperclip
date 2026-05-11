import { describe, expect, it } from "vitest";
import {
  AppleAdapterError,
  type AppleAdapterTransport,
  createAppleAdapter,
  createMockAppleAdapter,
} from "../services/apple-adapter.js";

const lookupInput = {
  companyId: "company-1",
  accountRef: "local-dev",
};

describe("Apple adapter interface mock baseline", () => {
  it("returns deterministic mock account and device metadata", async () => {
    const adapter = createMockAppleAdapter();

    await expect(adapter.getAccountMetadata(lookupInput)).resolves.toMatchObject({
      accountId: "mock-apple-account",
      displayName: "Mock Apple Developer",
      primaryEmail: "developer@example.invalid",
      teamId: "MOCKTEAM1",
      teamName: "Mock Apple Team",
      region: "US",
    });

    await expect(adapter.listDeviceMetadata(lookupInput)).resolves.toEqual([
      expect.objectContaining({
        deviceId: "mock-device-iphone",
        name: "Mock iPhone",
        platform: "ios",
        serialNumberLast4: "A1B2",
      }),
      expect.objectContaining({
        deviceId: "mock-device-mac",
        name: "Mock Mac",
        platform: "macos",
        serialNumberLast4: "C3D4",
      }),
    ]);
  });

  it("retries transient mock failures at the adapter boundary", async () => {
    const adapter = createMockAppleAdapter({
      transientFailuresBeforeSuccess: {
        getAccountMetadata: 2,
      },
    });

    await expect(adapter.getAccountMetadata(lookupInput, {
      retry: { maxAttempts: 3, baseDelayMs: 0 },
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      accountId: "mock-apple-account",
    });
  });

  it("surfaces timeout as a transient boundary error", async () => {
    const adapter = createMockAppleAdapter({ latencyMs: 50 });

    await expect(adapter.listDeviceMetadata(lookupInput, {
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      timeoutMs: 1,
    })).rejects.toMatchObject({
      name: "AppleAdapterError",
      code: "timeout",
      transient: true,
    } satisfies Partial<AppleAdapterError>);
  });

  it("enforces timeout at the boundary for a non-cooperative transport", async () => {
    const transport: AppleAdapterTransport = {
      getAccountMetadata: async () => new Promise(() => {}),
      listDeviceMetadata: async () => [],
    };
    const adapter = createAppleAdapter(transport);
    const startedAt = performance.now();

    await expect(adapter.getAccountMetadata(lookupInput, {
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      timeoutMs: 20,
    })).rejects.toMatchObject({
      name: "AppleAdapterError",
      code: "timeout",
      transient: true,
    } satisfies Partial<AppleAdapterError>);

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("retries timeout failures from non-cooperative transports", async () => {
    let attempts = 0;
    const transport: AppleAdapterTransport = {
      async getAccountMetadata() {
        attempts += 1;
        if (attempts === 1) return new Promise(() => {});
        return {
          accountId: "retry-success",
          fetchedAt: "2026-01-01T00:00:00.000Z",
        };
      },
      listDeviceMetadata: async () => [],
    };
    const adapter = createAppleAdapter(transport);

    await expect(adapter.getAccountMetadata(lookupInput, {
      retry: { maxAttempts: 2, baseDelayMs: 0 },
      timeoutMs: 20,
    })).resolves.toMatchObject({
      accountId: "retry-success",
    });
    expect(attempts).toBe(2);
  });
});
