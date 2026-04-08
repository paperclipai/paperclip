import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writePaperclipEnvFile } from "../execute.js";

describe("writePaperclipEnvFile", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes PAPERCLIP_* vars to .paperclip-env", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-"));
    const env = {
      PAPERCLIP_API_KEY: "test-key-123",
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_AGENT_ID: "agent-1",
      AGENT_HOME: "/home/test/agent",
      HOME: "/home/test",
      PATH: "/usr/bin",
    };

    await writePaperclipEnvFile(tmpDir, env);

    const content = await fs.readFile(path.join(tmpDir, ".paperclip-env"), "utf8");
    expect(content).toContain('export AGENT_HOME="/home/test/agent"');
    expect(content).toContain('export PAPERCLIP_API_KEY="test-key-123"');
    expect(content).toContain('export PAPERCLIP_API_URL="http://localhost:3100"');
    expect(content).toContain('export PAPERCLIP_AGENT_ID="agent-1"');
    // Should NOT include non-PAPERCLIP vars
    expect(content).not.toContain("export HOME=");
    expect(content).not.toContain("export PATH=");
  });

  it("skips writing when no PAPERCLIP vars exist", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-"));
    const env = { HOME: "/home/test", PATH: "/usr/bin" };

    await writePaperclipEnvFile(tmpDir, env);

    const exists = await fs.access(path.join(tmpDir, ".paperclip-env")).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("sorts keys alphabetically", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-"));
    const env = {
      PAPERCLIP_Z_LAST: "z",
      PAPERCLIP_A_FIRST: "a",
      AGENT_HOME: "/home",
    };

    await writePaperclipEnvFile(tmpDir, env);

    const content = await fs.readFile(path.join(tmpDir, ".paperclip-env"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines[0]).toContain("AGENT_HOME");
    expect(lines[1]).toContain("PAPERCLIP_A_FIRST");
    expect(lines[2]).toContain("PAPERCLIP_Z_LAST");
  });
});
