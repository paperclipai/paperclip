import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionKey } from "./execute.js";

async function writeClaimedApiKeyFileForTest(claimedApiKeyPath: string, authToken: string): Promise<void> {
  const module = await import("./execute.js");
  return (module as unknown as { writeClaimedApiKeyFile: (p: string, t: string) => Promise<void> }).writeClaimedApiKeyFile(
    claimedApiKeyPath,
    authToken,
  );
}

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

    await writeClaimedApiKeyFileForTest(targetPath, "token-123");

    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({ token: "token-123" });
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
