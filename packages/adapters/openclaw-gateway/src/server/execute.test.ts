import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionKey, writeClaimedApiKeyFile } from "./execute.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeClaimedApiKeyFile", () => {
  it("writes the run token JSON to the configured claimed key path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-openclaw-gateway-"));
    tempDirs.push(tempDir);
    const targetPath = path.join(tempDir, "paperclip-claimed-api-key.json");

    await writeClaimedApiKeyFile(targetPath, "token-123");

    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ token: "token-123" });
  });

  it("expands tilde-prefixed paths under the current home directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-openclaw-home-"));
    tempDirs.push(tempDir);
    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      const targetPath = "~/.openclaw/workspace/paperclip-claimed-api-key.json";
      const expandedPath = path.join(tempDir, ".openclaw", "workspace", "paperclip-claimed-api-key.json");

      await writeClaimedApiKeyFile(targetPath, "token-tilde");

      expect(JSON.parse(fs.readFileSync(expandedPath, "utf8"))).toEqual({ token: "token-tilde" });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});
