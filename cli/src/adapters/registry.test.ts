import { describe, expect, it } from "vitest";
import { getCLIAdapter } from "./registry.js";

// ============================================================================
// getCLIAdapter
// ============================================================================

describe("getCLIAdapter", () => {
  it("returns an adapter with type 'claude_local' for 'claude_local'", () => {
    const adapter = getCLIAdapter("claude_local");
    expect(adapter.type).toBe("claude_local");
  });

  it("returns an adapter with type 'cursor' for 'cursor'", () => {
    const adapter = getCLIAdapter("cursor");
    expect(adapter.type).toBe("cursor");
  });

  it("returns an adapter with type 'codex_local' for 'codex_local'", () => {
    const adapter = getCLIAdapter("codex_local");
    expect(adapter.type).toBe("codex_local");
  });

  it("returns an adapter with type 'opencode_local' for 'opencode_local'", () => {
    const adapter = getCLIAdapter("opencode_local");
    expect(adapter.type).toBe("opencode_local");
  });

  it("returns an adapter with type 'gemini_local' for 'gemini_local'", () => {
    const adapter = getCLIAdapter("gemini_local");
    expect(adapter.type).toBe("gemini_local");
  });

  it("returns an adapter with type 'openclaw_gateway' for 'openclaw_gateway'", () => {
    const adapter = getCLIAdapter("openclaw_gateway");
    expect(adapter.type).toBe("openclaw_gateway");
  });

  it("falls back to the process adapter for an unknown type", () => {
    const adapter = getCLIAdapter("__unknown_type__");
    expect(adapter).toBeDefined();
    expect(typeof adapter.formatStdoutEvent).toBe("function");
  });

  it("has a formatStdoutEvent function on every known adapter", () => {
    const knownTypes = [
      "claude_local",
      "codex_local",
      "opencode_local",
      "pi_local",
      "cursor",
      "gemini_local",
      "openclaw_gateway",
    ];
    for (const type of knownTypes) {
      const adapter = getCLIAdapter(type);
      expect(typeof adapter.formatStdoutEvent).toBe("function");
    }
  });
});
