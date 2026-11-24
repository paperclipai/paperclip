import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("claude-agent-acp Paperclip patch", () => {
  it("loads a shared skill home as a local Claude plugin in isolated sessions", async () => {
    const packageRoot = dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
    const source = await readFile(join(packageRoot, "dist", "acp-agent.js"), "utf8");
    expect(source).toContain('process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT === "1" && process.env.PAPERCLIP_CLAUDE_SKILL_PLUGIN_DIR?.startsWith("/")');
    expect(source).toContain('plugins: [{ type: "local", path: process.env.PAPERCLIP_CLAUDE_SKILL_PLUGIN_DIR }]');
  });
});
