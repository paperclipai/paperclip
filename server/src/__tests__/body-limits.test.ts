import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_JSON_BODY_LIMIT,
  PORTABLE_JSON_BODY_LIMIT,
  PORTABLE_JSON_BODY_LIMIT_BYTES,
  PORTABLE_ZIP_UPLOAD_LIMIT_BYTES,
} from "../http/body-limits.js";

describe("HTTP body limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the global JSON parser at the established ceiling", () => {
    expect(DEFAULT_JSON_BODY_LIMIT).toBe("10mb");
  });

  it("allows PAP-scale portable import JSON payloads", () => {
    expect(PORTABLE_JSON_BODY_LIMIT).toBe("64mb");
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("accepts large real-world compressed company packages by default", () => {
    expect(PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("lets operators override the zip upload cap via PAPERCLIP_IMPORT_ZIP_MAX_BYTES", async () => {
    vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", String(2 * 1024 * 1024 * 1024));
    vi.resetModules();
    const reloaded = await import("../http/body-limits.js");
    expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it("falls back to the default when the env override is not a usable number", async () => {
    for (const raw of ["unlimited", "0", "-5", "0.5"]) {
      vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", raw);
      vi.resetModules();
      const reloaded = await import("../http/body-limits.js");
      expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES, `override ${JSON.stringify(raw)}`).toBe(
        1024 * 1024 * 1024,
      );
    }
  });

  it("clamps an oversized override so derived guard math cannot overflow", async () => {
    vi.stubEnv("PAPERCLIP_IMPORT_ZIP_MAX_BYTES", String(Number.MAX_VALUE));
    vi.resetModules();
    const reloaded = await import("../http/body-limits.js");
    expect(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES).toBe(64 * 1024 * 1024 * 1024);
    expect(Number.isSafeInteger(reloaded.PORTABLE_ZIP_UPLOAD_LIMIT_BYTES * 4)).toBe(true);
  });
});
