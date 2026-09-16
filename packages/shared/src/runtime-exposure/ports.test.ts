import { describe, expect, it } from "vitest";
import {
  RUNTIME_EXPOSURE_APP_PORT_MAX,
  RUNTIME_EXPOSURE_APP_PORT_MIN,
  RUNTIME_EXPOSURE_HMR_PORT_MAX,
  RUNTIME_EXPOSURE_HMR_PORT_MIN,
  RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
  buildRuntimeExposureHealthUrl,
  buildRuntimeExposureUrl,
  deriveViteHmrPort,
  derivePaperclipViteHmrPort,
  isAllowedRuntimeExposurePort,
  isRuntimeExposureAppPort,
  isRuntimeExposureHmrPort,
} from "./ports.js";

describe("runtime exposure port policy", () => {
  it("accepts app ports only inside the dedicated range", () => {
    expect(isRuntimeExposureAppPort(RUNTIME_EXPOSURE_APP_PORT_MIN)).toBe(true);
    expect(isRuntimeExposureAppPort(RUNTIME_EXPOSURE_APP_PORT_MAX)).toBe(true);
    expect(isRuntimeExposureAppPort(RUNTIME_EXPOSURE_APP_PORT_MIN - 1)).toBe(false);
    expect(isRuntimeExposureAppPort(RUNTIME_EXPOSURE_APP_PORT_MAX + 1)).toBe(false);
  });

  it("rejects privileged, reserved, and non-integer ports", () => {
    expect(isAllowedRuntimeExposurePort(443)).toBe(false);
    expect(isAllowedRuntimeExposurePort(22)).toBe(false);
    expect(isAllowedRuntimeExposurePort(3100)).toBe(false);
    expect(isAllowedRuntimeExposurePort(0)).toBe(false);
    expect(isAllowedRuntimeExposurePort(65536)).toBe(false);
    expect(isAllowedRuntimeExposurePort(42000.5)).toBe(false);
    expect(isAllowedRuntimeExposurePort(Number.NaN)).toBe(false);
  });

  it("keeps the HMR range in sync with the offset", () => {
    expect(RUNTIME_EXPOSURE_HMR_PORT_MIN).toBe(
      RUNTIME_EXPOSURE_APP_PORT_MIN + RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
    );
    expect(RUNTIME_EXPOSURE_HMR_PORT_MAX).toBe(
      RUNTIME_EXPOSURE_APP_PORT_MAX + RUNTIME_EXPOSURE_HMR_PORT_OFFSET,
    );
    expect(isRuntimeExposureHmrPort(RUNTIME_EXPOSURE_HMR_PORT_MIN)).toBe(true);
    expect(isAllowedRuntimeExposurePort(RUNTIME_EXPOSURE_HMR_PORT_MIN)).toBe(true);
  });

  it("derives a deterministic HMR companion port and rejects out-of-range apps", () => {
    expect(deriveViteHmrPort(42000)).toBe(52000);
    expect(deriveViteHmrPort(42123)).toBe(52123);
    expect(() => deriveViteHmrPort(3100)).toThrow(RangeError);
    expect(() => deriveViteHmrPort(52000)).toThrow(RangeError);
  });

  it("shares the generic Paperclip HMR derivation with high-port overflow fallback", () => {
    expect(derivePaperclipViteHmrPort(3_100)).toBe(13_100);
    expect(derivePaperclipViteHmrPort(55_535)).toBe(65_535);
    expect(derivePaperclipViteHmrPort(55_536)).toBe(45_536);
    expect(() => derivePaperclipViteHmrPort(0)).toThrow(/valid TCP port/);
  });

  it("builds https URLs on the non-standard port", () => {
    expect(buildRuntimeExposureUrl("paperclip-dev.tail29c1aa.ts.net", 42010)).toBe(
      "https://paperclip-dev.tail29c1aa.ts.net:42010",
    );
    expect(buildRuntimeExposureHealthUrl("paperclip-dev.tail29c1aa.ts.net", 42010)).toBe(
      "https://paperclip-dev.tail29c1aa.ts.net:42010/api/health",
    );
  });

  it("rejects empty hostnames and out-of-range ports when building URLs", () => {
    expect(() => buildRuntimeExposureUrl("", 42010)).toThrow();
    expect(() => buildRuntimeExposureUrl("host", 443)).toThrow(RangeError);
  });
});
