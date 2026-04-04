import { describe, expect, it } from "vitest";
import { findServerAdapter, getServerAdapter } from "../adapters/index.js";

describe("server adapter registry", () => {
  it("resolves legacy hyphenated adapter aliases", () => {
    expect(getServerAdapter("codex-local").type).toBe("codex_local");
    expect(findServerAdapter("claude-local")?.type).toBe("claude_local");
    expect(findServerAdapter("openclaw-gateway")?.type).toBe("openclaw_gateway");
  });

  it("still falls back to process for unknown adapters", () => {
    expect(getServerAdapter("unknown_adapter").type).toBe("process");
    expect(findServerAdapter("unknown_adapter")).toBeNull();
  });
});
