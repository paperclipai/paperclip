import { describe, expect, it } from "vitest";
import {
  AppleAdapterError,
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
});

