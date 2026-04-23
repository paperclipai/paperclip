import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDataDirOverride } from "./data-dir.js";

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HOME", "");
  vi.stubEnv("PAPERCLIP_CONFIG", "");
  vi.stubEnv("PAPERCLIP_CONTEXT", "");
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================================
// applyDataDirOverride — no dataDir
// ============================================================================

describe("applyDataDirOverride — no dataDir", () => {
  it("returns null when dataDir is not provided", () => {
    expect(applyDataDirOverride({})).toBeNull();
  });

  it("returns null when dataDir is an empty string", () => {
    expect(applyDataDirOverride({ dataDir: "" })).toBeNull();
  });

  it("returns null when dataDir is whitespace only", () => {
    expect(applyDataDirOverride({ dataDir: "   " })).toBeNull();
  });

  it("does not set PAPERCLIP_HOME when dataDir is absent", () => {
    applyDataDirOverride({});
    expect(process.env.PAPERCLIP_HOME).toBe("");
  });
});

// ============================================================================
// applyDataDirOverride — with dataDir
// ============================================================================

describe("applyDataDirOverride — with dataDir", () => {
  it("returns the resolved absolute path when dataDir is provided", () => {
    const result = applyDataDirOverride({ dataDir: "/custom/data" });
    expect(result).toBe("/custom/data");
  });

  it("sets PAPERCLIP_HOME to the resolved dataDir", () => {
    applyDataDirOverride({ dataDir: "/custom/data" });
    expect(process.env.PAPERCLIP_HOME).toBe("/custom/data");
  });

  it("resolves a relative dataDir to an absolute path", () => {
    const result = applyDataDirOverride({ dataDir: "relative/dir" });
    expect(result).not.toBeNull();
    if (result) expect(result.startsWith("/")).toBe(true);
  });
});

// ============================================================================
// applyDataDirOverride — hasConfigOption
// ============================================================================

describe("applyDataDirOverride — hasConfigOption", () => {
  it("sets PAPERCLIP_CONFIG when hasConfigOption=true and no config override exists", () => {
    applyDataDirOverride({ dataDir: "/data" }, { hasConfigOption: true });
    expect(process.env.PAPERCLIP_CONFIG).toBeTruthy();
    expect(process.env.PAPERCLIP_CONFIG).toContain("config.json");
  });

  it("does not overwrite PAPERCLIP_CONFIG when it is already set", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", "/existing/config.json");
    applyDataDirOverride({ dataDir: "/data" }, { hasConfigOption: true });
    expect(process.env.PAPERCLIP_CONFIG).toBe("/existing/config.json");
  });

  it("does not overwrite PAPERCLIP_CONFIG when options.config is provided", () => {
    applyDataDirOverride(
      { dataDir: "/data", config: "/override/config.json" },
      { hasConfigOption: true },
    );
    // options.config means there is a config override — PAPERCLIP_CONFIG should not be set
    expect(process.env.PAPERCLIP_CONFIG ?? "").not.toContain("config.json");
  });

  it("does not set PAPERCLIP_CONFIG when hasConfigOption is false", () => {
    applyDataDirOverride({ dataDir: "/data" }, { hasConfigOption: false });
    expect(process.env.PAPERCLIP_CONFIG ?? "").toBe("");
  });
});

// ============================================================================
// applyDataDirOverride — hasContextOption
// ============================================================================

describe("applyDataDirOverride — hasContextOption", () => {
  it("sets PAPERCLIP_CONTEXT when hasContextOption=true and no context override exists", () => {
    applyDataDirOverride({ dataDir: "/data" }, { hasContextOption: true });
    expect(process.env.PAPERCLIP_CONTEXT).toBeTruthy();
    expect(process.env.PAPERCLIP_CONTEXT).toContain("context.json");
  });

  it("does not overwrite PAPERCLIP_CONTEXT when it is already set", () => {
    vi.stubEnv("PAPERCLIP_CONTEXT", "/existing/context.json");
    applyDataDirOverride({ dataDir: "/data" }, { hasContextOption: true });
    expect(process.env.PAPERCLIP_CONTEXT).toBe("/existing/context.json");
  });

  it("does not set PAPERCLIP_CONTEXT when hasContextOption is false", () => {
    applyDataDirOverride({ dataDir: "/data" }, { hasContextOption: false });
    expect(process.env.PAPERCLIP_CONTEXT ?? "").toBe("");
  });
});
