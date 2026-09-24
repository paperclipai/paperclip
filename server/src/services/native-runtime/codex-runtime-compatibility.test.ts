import { describe, expect, it, vi } from "vitest";
import {
  isSupportedRemoteCodexVersion,
  parseCodexCliVersion,
} from "./codex-runtime-compatibility.js";

describe("remote Codex compatibility window", () => {
  it("keeps the fixed minimum supported as time passes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      expect(isSupportedRemoteCodexVersion("0.149.0")).toBe(true);
      expect(isSupportedRemoteCodexVersion("0.148.99")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["0.149.0", "0.149.1", "0.150.0", "0.150.1", "0.151.0", "0.152.1", "0.153.4", "0.154.0", "0.155.1", "0.156.0", "0.156.99"])(
    "accepts stable supported version %s", (version) => {
      expect(isSupportedRemoteCodexVersion(version)).toBe(true);
      expect(parseCodexCliVersion(`codex-cli ${version}\n`)).toBe(version);
    },
  );
  it.each(["0.148.99", "0.100.0", "0.157.0", "0.999.0", "1.0.0", "0.156.0-alpha.1", "0.149.0-dev", "0.156.0+custom", "00.149.0", "0.149", "0.149.9007199254740992", ""])(
    "rejects unsupported or ambiguous version %s", (version) => {
      expect(isSupportedRemoteCodexVersion(version)).toBe(false);
    },
  );
  it("allows separate diagnostic lines and stderr version output", () => {
    expect(parseCodexCliVersion("WARNING: PATH unchanged\r\n\rcodex-cli 0.149.0\r\n")).toBe("0.149.0");
  });
  it.each([
    "codex-cli 0.156.0-alpha.1", "codex-cli 0.156.0+custom", "codex-cli 0.156.0 garbage",
    "wrapper says codex-cli 0.156.0", "codex 0.156.0", "0.156.0", "",
    "codex-cli 0.149.0\ncodex-cli 0.156.0",
  ])("does not partially parse %j as a supported stable CLI", (output) => {
    expect(parseCodexCliVersion(output)).toBeNull();
  });
});
