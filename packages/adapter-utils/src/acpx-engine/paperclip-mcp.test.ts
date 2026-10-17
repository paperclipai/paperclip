import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPERCLIP_MCP_TOOLS,
  PAPERCLIP_MCP_FORWARDED_ENV,
  buildPaperclipMcpServerConfig,
  readPaperclipMcpSelection,
  resolvePaperclipMcpEntrypoint,
} from "./paperclip-mcp.js";

describe("readPaperclipMcpSelection", () => {
  it("stays off unless explicitly enabled", () => {
    expect(readPaperclipMcpSelection({})).toBeNull();
    expect(readPaperclipMcpSelection({ paperclipMcp: false })).toBeNull();
    expect(readPaperclipMcpSelection({ paperclipMcp: {} })).toBeNull();
    expect(readPaperclipMcpSelection({ paperclipMcp: { enabled: false } })).toBeNull();
    expect(readPaperclipMcpSelection({ paperclipMcp: "yes" })).toBeNull();
  });

  it("defaults to the issue workflow tools and never to the broad request tool", () => {
    const expected = { tools: [...DEFAULT_PAPERCLIP_MCP_TOOLS], rejectedTools: [] };
    expect(readPaperclipMcpSelection({ paperclipMcp: true })).toEqual(expected);
    expect(readPaperclipMcpSelection({ paperclipMcp: { enabled: true } })).toEqual(expected);
    expect(DEFAULT_PAPERCLIP_MCP_TOOLS).not.toContain("paperclipApiRequest");
    expect(DEFAULT_PAPERCLIP_MCP_TOOLS).not.toContain("paperclipCreateIssue");
  });

  it("de-duplicates the allowlist and reports names that are not tool identifiers", () => {
    expect(
      readPaperclipMcpSelection({
        paperclipMcp: { enabled: true, tools: ["paperclipGetIssue", "paperclipGetIssue", "../x", "a b", ""] },
      }),
    ).toEqual({ tools: ["paperclipGetIssue"], rejectedTools: ["../x", "a b", ""] });
  });
});

describe("buildPaperclipMcpServerConfig", () => {
  it("forwards credentials by variable name and carries no secret values", () => {
    const config = buildPaperclipMcpServerConfig({
      entrypoint: "/opt/mcp/stdio.js",
      tools: ["paperclipAddComment"],
      nodeExecutable: "/usr/bin/node",
    });
    expect(config).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/mcp/stdio.js"],
      env_vars: [...PAPERCLIP_MCP_FORWARDED_ENV],
      default_tools_approval_mode: "approve",
      enabled_tools: ["paperclipAddComment"],
    });
    expect(config).not.toHaveProperty("env");
  });
});

describe("resolvePaperclipMcpEntrypoint", () => {
  it("returns an existing script path or null, never a missing file", async () => {
    const entrypoint = await resolvePaperclipMcpEntrypoint();
    if (entrypoint === null) return;
    expect(entrypoint.endsWith("stdio.js")).toBe(true);
    await expect(fs.access(entrypoint)).resolves.toBeUndefined();
  });
});
