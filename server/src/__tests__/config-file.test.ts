import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/8908
 *
 * When an instance config.json fails schema validation, readConfigFile()
 * used to swallow the Zod error in an empty `catch {}` and silently boot with
 * all defaults — while the startup banner still printed the ignored config
 * path, making the failure very hard to trace. It must now (a) still fall back
 * to defaults (return null) and (b) log a WARN naming the offending field so
 * operators can diagnose it.
 */

const mockResolvePath = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, existsSync: () => true, readFileSync: mockReadFileSync }, existsSync: () => true, readFileSync: mockReadFileSync };
});
vi.mock("../paths.js", () => ({ resolvePaperclipConfigPath: mockResolvePath }));

import { readConfigFile } from "../config-file.ts";

describe("readConfigFile invalid-config diagnostics (#8908)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and WARNs with the offending field path on schema failure", () => {
    // Unique path per test so the warn-once cache doesn't suppress this call.
    mockResolvePath.mockReturnValue("/tmp/pc-test-schema.json");
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        $meta: { version: 1, updatedAt: "2026-07-03T01:12:00.000Z", source: "provisioned-by-script" },
        server: { deploymentMode: "local_trusted", port: 3112 },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readConfigFile()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("/tmp/pc-test-schema.json");
    expect(msg).toContain("$meta.source");
  });

  it("returns null and WARNs on invalid JSON", () => {
    mockResolvePath.mockReturnValue("/tmp/pc-test-json.json");
    mockReadFileSync.mockReturnValue("{ not json ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readConfigFile()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("invalid JSON");
  });
});
