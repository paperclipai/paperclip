import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";
import { writeFakeGeminiCommand } from "./test-helpers.js";

describe("gemini session truncation", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-truncation-"));
    previousHome = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("truncates large session files while preserving mission and tail", async () => {
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const agentId = "agent-t";
    const companyId = "company-t";
    const sessionId = "big-session";
    const sharedDir = path.join(root, ".gemini", "companies", companyId, "chats");
    const sessionFile = path.join(sharedDir, `${sessionId}.jsonl`);

    await fs.mkdir(sharedDir, { recursive: true });

    // 1. Create a large session file (> 10MB)
    const header = JSON.stringify({ sessionId, kind: "main" });
    const mission = JSON.stringify({ id: "mission-1", type: "user", content: [{ text: "Your mission is X" }] });
    const filler = "X".repeat(1024 * 100); // 1KB lines
    const largeEvents = Array.from({ length: 110 }, (_, i) => 
      JSON.stringify({ id: `event-${i}`, type: "assistant", content: [{ text: `Filler ${i} ${filler}` }] })
    );
    const tailEvents = Array.from({ length: 10 }, (_, i) => 
      JSON.stringify({ id: `tail-${i}`, type: "user", content: [{ text: `Recent ${i}` }] })
    );

    const fullContent = [header, mission, ...largeEvents, ...tailEvents].join("\n") + "\n";
    await fs.writeFile(sessionFile, fullContent, "utf8");
    const originalSize = (await fs.stat(sessionFile)).size;
    expect(originalSize).toBeGreaterThan(10 * 1024 * 1024);

    // 2. Execute
    await execute({
      runId: "run-t",
      agent: { id: agentId, companyId, name: "G", adapterType: "gemini_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspace }, sessionDisplayId: sessionId, taskKey: null },
      config: { command: commandPath, cwd: workspace },
      context: {},
      authToken: "t",
      onLog: async () => {},
    });

    // 3. Verify truncation
    const truncatedContent = await fs.readFile(sessionFile, "utf8");
    const lines = truncatedContent.split("\n").filter(l => l.trim().length > 0);
    
    expect(truncatedContent.length).toBeLessThan(originalSize);
    expect(lines[0]).toBe(header);
    expect(lines[1]).toBe(mission);
    expect(lines[2]).toContain("Session truncated for performance");
    
    // Verify tail preservation (last 10 events we added should be there, plus possibly some filler if tailCount=50)
    expect(truncatedContent).toContain("Recent 9");
    
    // Verify backup exists
    const archiveDir = path.join(sharedDir, "archives");
    const archives = await fs.readdir(archiveDir);
    expect(archives.length).toBe(1);
    expect(archives[0]).toContain(sessionId);
  });

  it("truncates sessions with few but very large events", async () => {
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const agentId = "agent-s";
    const companyId = "company-s";
    const sessionId = "dense-session";
    const sharedDir = path.join(root, ".gemini", "companies", companyId, "chats");
    const sessionFile = path.join(sharedDir, `${sessionId}.jsonl`);

    await fs.mkdir(sharedDir, { recursive: true });

    // 1. Create a session with only 10 lines but 15MB total
    const header = JSON.stringify({ sessionId, kind: "main" });
    const mission = JSON.stringify({ id: "mission-1", type: "user", content: [{ text: "Mission" }] });
    const hugeFiller = "X".repeat(2 * 1024 * 1024); // 2MB lines
    const largeEvents = Array.from({ length: 7 }, (_, i) => 
      JSON.stringify({ id: `event-${i}`, type: "assistant", content: [{ text: `Huge ${i} ${hugeFiller}` }] })
    );

    const fullContent = [header, mission, ...largeEvents].join("\n") + "\n";
    await fs.writeFile(sessionFile, fullContent, "utf8");
    const originalSize = (await fs.stat(sessionFile)).size;
    expect(originalSize).toBeGreaterThan(10 * 1024 * 1024);
    expect(fullContent.split("\n").filter(Boolean).length).toBeLessThan(100);

    // 2. Execute
    await execute({
      runId: "run-s",
      agent: { id: agentId, companyId, name: "G", adapterType: "gemini_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: workspace }, sessionDisplayId: sessionId, taskKey: null },
      config: { command: commandPath, cwd: workspace },
      context: {},
      authToken: "t",
      onLog: async () => {},
    });

    // 3. Verify truncation happened
    const truncatedContent = await fs.readFile(sessionFile, "utf8");
    expect(truncatedContent.length).toBeLessThan(originalSize);
    expect(truncatedContent).toContain("Session truncated for performance");
  });
});
