import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseQuotaResetDelaySec, writePaperclipEnvFile } from "../execute.js";
import { detectGeminiQuotaExhausted } from "../parse.js";

describe("parseQuotaResetDelaySec", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(
      parseQuotaResetDelaySec("Your quota will reset after 15h5m10s."),
    ).toBe(15 * 3600 + 5 * 60 + 10);
  });

  it("parses hours only", () => {
    expect(parseQuotaResetDelaySec("reset after 2h")).toBe(7200);
  });

  it("parses minutes and seconds", () => {
    expect(parseQuotaResetDelaySec("reset after 30m45s")).toBe(30 * 60 + 45);
  });

  it("returns null when no reset duration found", () => {
    expect(parseQuotaResetDelaySec("some random error")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseQuotaResetDelaySec("")).toBeNull();
  });

  it("handles real Gemini error message", () => {
    const stderr =
      "TerminalQuotaError: You have exhausted your capacity on this model. " +
      "Your quota will reset after 15h5m10s.";
    expect(parseQuotaResetDelaySec(stderr)).toBe(54310);
  });
});

describe("detectGeminiQuotaExhausted", () => {
  it("detects quota exhaustion from stderr", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "",
      stderr: "TerminalQuotaError: You have exhausted your capacity on this model.",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects 429 status code", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "",
      stderr: "Error: 429 Too Many Requests",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects resource_exhausted", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: '{"error":{"code":"RESOURCE_EXHAUSTED"}}',
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("returns false for non-quota errors", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "",
      stderr: "Error: network timeout",
    });
    expect(result.exhausted).toBe(false);
  });
});

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
