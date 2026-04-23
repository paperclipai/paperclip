import { describe, expect, it, vi } from "vitest";
import { configCheck } from "./config-check.js";

vi.mock("../config/store.js", () => ({
  resolveConfigPath: vi.fn((p?: string) => p ?? "/fake/.paperclip/config.json"),
  configExists: vi.fn(),
  readConfig: vi.fn(),
}));

import { configExists, readConfig, resolveConfigPath } from "../config/store.js";
const mockConfigExists = vi.mocked(configExists);
const mockReadConfig = vi.mocked(readConfig);
const mockResolveConfigPath = vi.mocked(resolveConfigPath);

// ============================================================================
// configCheck — config file missing
// ============================================================================

describe("configCheck — config file missing", () => {
  it("returns fail when config does not exist", () => {
    mockConfigExists.mockReturnValue(false);
    const result = configCheck();
    expect(result.status).toBe("fail");
  });

  it("sets name to 'Config file'", () => {
    mockConfigExists.mockReturnValue(false);
    const result = configCheck();
    expect(result.name).toBe("Config file");
  });

  it("includes the config path in the failure message", () => {
    mockConfigExists.mockReturnValue(false);
    mockResolveConfigPath.mockReturnValue("/custom/path/config.json");
    const result = configCheck();
    expect(result.message).toContain("/custom/path/config.json");
  });

  it("includes a hint about paperclipai onboard", () => {
    mockConfigExists.mockReturnValue(false);
    const result = configCheck();
    expect(result.repairHint).toContain("onboard");
  });

  it("sets canRepair to false", () => {
    mockConfigExists.mockReturnValue(false);
    const result = configCheck();
    expect(result.canRepair).toBe(false);
  });
});

// ============================================================================
// configCheck — config file present and valid
// ============================================================================

describe("configCheck — valid config", () => {
  it("returns pass when config exists and parses successfully", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockReturnValue({} as any);
    const result = configCheck();
    expect(result.status).toBe("pass");
  });

  it("includes the config path in the pass message", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockReturnValue({} as any);
    mockResolveConfigPath.mockReturnValue("/home/.paperclip/config.json");
    const result = configCheck();
    expect(result.message).toContain("/home/.paperclip/config.json");
  });
});

// ============================================================================
// configCheck — config file present but invalid
// ============================================================================

describe("configCheck — invalid config", () => {
  it("returns fail when readConfig throws", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockImplementation(() => {
      throw new Error("Invalid JSON");
    });
    const result = configCheck();
    expect(result.status).toBe("fail");
  });

  it("includes the error message in the failure", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockImplementation(() => {
      throw new Error("unexpected field 'xyz'");
    });
    const result = configCheck();
    expect(result.message).toContain("unexpected field 'xyz'");
  });

  it("falls back to String() for non-Error throws", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockImplementation(() => {
      throw "malformed";
    });
    const result = configCheck();
    expect(result.message).toContain("malformed");
  });

  it("includes hint about paperclipai configure on invalid config", () => {
    mockConfigExists.mockReturnValue(true);
    mockReadConfig.mockImplementation(() => {
      throw new Error("bad");
    });
    const result = configCheck();
    expect(result.repairHint).toContain("configure");
  });
});
