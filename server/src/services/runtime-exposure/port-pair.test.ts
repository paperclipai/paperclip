import { describe, expect, it } from "vitest";

import {
  RUNTIME_EXPOSURE_APP_PORT_MIN,
  RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
} from "@paperclipai/shared";

import { allocateExposurePortPair } from "./port-pair.js";

describe("allocateExposurePortPair", () => {
  it("returns the first free app port with a free HMR companion", async () => {
    const pair = await allocateExposurePortPair({ isPortAvailable: async () => true });
    expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);
    expect(pair.hmrPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET);
  });

  it("skips an app port whose HMR companion is busy", async () => {
    const busyHmr = RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET;
    const pair = await allocateExposurePortPair({
      isPortAvailable: async (port) => port !== busyHmr,
    });
    // First app port's companion is busy, so it advances to the next app port.
    expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + 1);
    expect(pair.hmrPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + 1 + RUNTIME_EXPOSURE_HMR_PORT_OFFSET);
  });

  it("skips a busy app port", async () => {
    const pair = await allocateExposurePortPair({
      isPortAvailable: async (port) => port !== RUNTIME_EXPOSURE_APP_PORT_MIN,
    });
    expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + 1);
  });

  it("never returns a reserved (e.g. quarantined) app or HMR port", async () => {
    const reserved = new Set<number>([
      RUNTIME_EXPOSURE_APP_PORT_MIN,
      // reserve the SECOND app port's HMR companion too
      RUNTIME_EXPOSURE_APP_PORT_MIN + 1 + RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
    ]);
    const pair = await allocateExposurePortPair({
      isPortAvailable: async () => true,
      reserved,
    });
    expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + 2);
  });

  describe("preferredAppPort (keep existing runtime ports when safe)", () => {
    it("keeps a preferred in-range port instead of restarting the scan", async () => {
      const pair = await allocateExposurePortPair({
        isPortAvailable: async () => true,
        preferredAppPort: 42_500,
      });
      expect(pair.appPort).toBe(42_500);
      expect(pair.hmrPort).toBe(42_500 + RUNTIME_EXPOSURE_HMR_PORT_OFFSET);
    });

    it("ignores a legacy pinned port outside the dedicated range", async () => {
      // 45439 is the pre-feature Paperclip App port; the broker can never
      // publish it, so the allocator must relocate rather than fail.
      const pair = await allocateExposurePortPair({
        isPortAvailable: async () => true,
        preferredAppPort: 45_439,
      });
      expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);
    });

    it("falls back to the scan when the preferred port is busy or reserved", async () => {
      const busy = await allocateExposurePortPair({
        isPortAvailable: async (port) => port !== 42_500,
        preferredAppPort: 42_500,
      });
      expect(busy.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);

      const reservedCompanion = await allocateExposurePortPair({
        isPortAvailable: async () => true,
        reserved: new Set([42_500 + RUNTIME_EXPOSURE_HMR_PORT_OFFSET]),
        preferredAppPort: 42_500,
      });
      expect(reservedCompanion.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);
    });

    it("ignores a preferred HMR-range port (never an app port)", async () => {
      const pair = await allocateExposurePortPair({
        isPortAvailable: async () => true,
        preferredAppPort: RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
      });
      expect(pair.appPort).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);
    });
  });

  it("throws when the dedicated range is exhausted", async () => {
    await expect(
      allocateExposurePortPair({ isPortAvailable: async () => false }),
    ).rejects.toThrow(/no free app\/HMR port pair/);
  });

  it("only probes the companion after the app port is free (short-circuits)", async () => {
    const probed: number[] = [];
    await allocateExposurePortPair({
      isPortAvailable: async (port) => {
        probed.push(port);
        return true;
      },
    });
    // First two probes are the first app port and its companion, in order.
    expect(probed[0]).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN);
    expect(probed[1]).toBe(RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET);
  });
});
