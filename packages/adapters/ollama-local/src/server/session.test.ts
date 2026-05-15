import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSessionPath,
  loadSession,
  saveSession,
  sessionMatchesCurrentRun,
  type OllamaSessionState,
} from "./session.js";

describe("session", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ollama-session-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("buildSessionPath sanitizes agent ids", () => {
    const p = buildSessionPath("../etc/passwd", "2026-05-05T12:00:00.000Z");
    expect(path.basename(p)).not.toContain("../");
    expect(path.basename(p)).toContain("etc_passwd");
  });

  it("saveSession + loadSession round-trips message history", async () => {
    const sessionPath = path.join(tmpDir, "session.json");
    const state: OllamaSessionState = {
      agentId: "agent_1",
      cwd: "/work",
      model: "qwen2.5-coder:14b",
      host: "http://localhost:11434",
      cloud: false,
      messages: [
        { role: "system", content: "be useful" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveSession(sessionPath, state);
    const loaded = await loadSession(sessionPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.agentId).toBe("agent_1");
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[2].content).toBe("hello");
  });

  it("loadSession returns null for missing file", async () => {
    const loaded = await loadSession(path.join(tmpDir, "missing.json"));
    expect(loaded).toBeNull();
  });

  it("loadSession returns null for malformed json", async () => {
    const sessionPath = path.join(tmpDir, "bad.json");
    await fs.writeFile(sessionPath, "{not json", "utf8");
    expect(await loadSession(sessionPath)).toBeNull();
  });

  it("sessionMatchesCurrentRun catches model + host changes", () => {
    const base = {
      agentId: "a",
      cwd: "/work",
      model: "qwen2.5-coder:14b",
      host: "http://localhost:11434",
      cloud: false,
      messages: [],
      createdAt: "",
      updatedAt: "",
    } satisfies OllamaSessionState;
    expect(
      sessionMatchesCurrentRun(base, {
        cwd: "/work",
        model: "qwen2.5-coder:14b",
        host: "http://localhost:11434",
      }),
    ).toBe(true);
    expect(
      sessionMatchesCurrentRun(base, {
        cwd: "/work",
        model: "different-model",
        host: "http://localhost:11434",
      }),
    ).toBe(false);
    expect(
      sessionMatchesCurrentRun(base, {
        cwd: "/other",
        model: "qwen2.5-coder:14b",
        host: "http://localhost:11434",
      }),
    ).toBe(false);
  });
});
