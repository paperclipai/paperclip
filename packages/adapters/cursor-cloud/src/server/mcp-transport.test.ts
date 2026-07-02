import { describe, expect, it } from "vitest";
import { assertAllowedMcpTransport, isMcpRemoteCommand } from "./mcp-transport.js";

describe("mcp-transport", () => {
  it("rejects sse transport", () => {
    expect(() =>
      assertAllowedMcpTransport({ name: "x", transport: "sse", url: "https://x/mcp" }),
    ).toThrow(/sse.*not supported/i);
  });

  it("rejects mcp-remote stdio bridge", () => {
    expect(isMcpRemoteCommand("npx", ["-y", "mcp-remote", "https://x"])).toBe(true);
    expect(() =>
      assertAllowedMcpTransport({
        name: "remote",
        transport: "stdio",
        command: "npx",
        args: ["-y", "mcp-remote", "https://example.com/mcp"],
      }),
    ).toThrow(/mcp-remote/i);
  });

  it("allows http and stdio (non mcp-remote)", () => {
    expect(() =>
      assertAllowedMcpTransport({
        name: "gh",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      }),
    ).not.toThrow();
  });
});
