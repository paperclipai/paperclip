import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { withCodexMcpStartupWait, withCodexMcpStartupWaitConfig } from "./codex-mcp-startup.js";

describe("withCodexMcpStartupWait", () => {
  it("adds the grace key before the first table so it stays top-level", () => {
    const next = withCodexMcpStartupWait('model = "gpt-5"\n\n[mcp_servers.fixture]\nurl = "https://tools.example/mcp"\n', true);
    const parsed = parseToml(next) as Record<string, unknown>;
    expect(parsed.mcp_optional_startup_grace_ms).toBe(0);
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers).toEqual({ fixture: { url: "https://tools.example/mcp" } });
    expect(next.indexOf("mcp_optional_startup_grace_ms")).toBeLessThan(next.indexOf("[mcp_servers"));
  });

  it("is idempotent and removable", () => {
    const once = withCodexMcpStartupWait("", true);
    const twice = withCodexMcpStartupWait(once, true);
    expect(twice).toBe(once);
    expect(once.match(/mcp_optional_startup_grace_ms/g)).toHaveLength(1);
    expect(withCodexMcpStartupWait(once, false)).toBe("");
  });

  it("keeps an operator-set grace value", () => {
    const config = "mcp_optional_startup_grace_ms = 2500\n";
    expect(withCodexMcpStartupWait(config, true)).toBe(config);
  });

  it("does not mistake a table key of the same name for the top-level key", () => {
    const next = withCodexMcpStartupWait("[other]\nmcp_optional_startup_grace_ms = 5\n", true);
    const parsed = parseToml(next) as Record<string, unknown>;
    expect(parsed.mcp_optional_startup_grace_ms).toBe(0);
    expect(parsed.other).toEqual({ mcp_optional_startup_grace_ms: 5 });
  });
});

describe("withCodexMcpStartupWaitConfig", () => {
  it("sets the grace to zero only when absent", () => {
    expect(withCodexMcpStartupWaitConfig({ model: "m" })).toEqual({ model: "m", mcp_optional_startup_grace_ms: 0 });
    expect(withCodexMcpStartupWaitConfig({ mcp_optional_startup_grace_ms: 300 })).toEqual({ mcp_optional_startup_grace_ms: 300 });
  });
});
