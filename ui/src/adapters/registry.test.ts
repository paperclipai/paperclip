import { describe, expect, it, vi } from "vitest";

vi.mock("./claude-local", () => ({
  claudeLocalUIAdapter: { type: "claude_local", label: "Claude" },
}));
vi.mock("./codex-local", () => ({
  codexLocalUIAdapter: { type: "codex_local", label: "Codex" },
}));
vi.mock("./cursor", () => ({
  cursorLocalUIAdapter: { type: "cursor", label: "Cursor" },
}));
vi.mock("./gemini-local", () => ({
  geminiLocalUIAdapter: { type: "gemini_local", label: "Gemini" },
}));
vi.mock("./opencode-local", () => ({
  openCodeLocalUIAdapter: { type: "opencode_local", label: "OpenCode" },
}));
vi.mock("./pi-local", () => ({
  piLocalUIAdapter: { type: "pi_local", label: "Pi" },
}));
vi.mock("./openclaw-gateway", () => ({
  openClawGatewayUIAdapter: { type: "openclaw_gateway", label: "OpenClaw" },
}));
vi.mock("./process", () => ({
  processUIAdapter: { type: "process", label: "Process" },
}));
vi.mock("./http", () => ({
  httpUIAdapter: { type: "http", label: "HTTP" },
}));

import { getUIAdapter } from "./registry";

describe("ui adapter registry", () => {
  it("resolves legacy hyphenated adapter aliases", () => {
    expect(getUIAdapter("codex-local").type).toBe("codex_local");
    expect(getUIAdapter("claude-local").type).toBe("claude_local");
  });

  it("still falls back to process for unknown adapters", () => {
    expect(getUIAdapter("unknown_adapter").type).toBe("process");
  });
});
