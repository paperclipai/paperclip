import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";
import { writeFakeGeminiCommand } from "./test-helpers.js";

describe("gemini shared chats", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-shared-"));
    previousHome = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sets up shared company chat storage and migrates existing chats", async () => {
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const agentId = "agent-1";
    const companyId = "company-1";
    const agentTmpDir = path.join(root, ".gemini", "tmp", agentId);
    const agentChatsDir = path.join(agentTmpDir, "chats");
    const sharedDir = path.join(root, ".gemini", "companies", companyId, "chats");

    // 1. Pre-create some chats in the agent's directory
    await fs.mkdir(agentChatsDir, { recursive: true });
    await fs.writeFile(path.join(agentChatsDir, "old-session.jsonl"), "data");

    // 2. Execute
    await execute({
      runId: "run-1",
      agent: { id: agentId, companyId, name: "G", adapterType: "gemini_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: workspace },
      context: {},
      authToken: "t",
      onLog: async () => {},
    });

    // 3. Verify migration
    const sharedFiles = await fs.readdir(sharedDir);
    expect(sharedFiles).toContain("old-session.jsonl");

    // 4. Verify symlink
    const stats = await fs.lstat(agentChatsDir);
    expect(stats.isSymbolicLink()).toBe(true);
    const target = await fs.readlink(agentChatsDir);
    expect(path.resolve(root, target)).toBe(path.resolve(sharedDir));
  });

  it("reuses existing shared storage", async () => {
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const agentId = "agent-2";
    const companyId = "company-2";
    const sharedDir = path.join(root, ".gemini", "companies", companyId, "chats");
    
    // 1. Pre-create shared storage
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "existing.jsonl"), "data");

    // 2. Execute
    await execute({
      runId: "run-2",
      agent: { id: agentId, companyId, name: "G", adapterType: "gemini_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: workspace },
      context: {},
      authToken: "t",
      onLog: async () => {},
    });

    // 3. Verify agent now points to it
    const agentChatsDir = path.join(root, ".gemini", "tmp", agentId, "chats");
    const agentFiles = await fs.readdir(agentChatsDir);
    expect(agentFiles).toContain("existing.jsonl");
  });

  it("does not remove agent directory if migration fails", async () => {
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const agentId = "agent-3";
    const companyId = "company-3";
    const agentTmpDir = path.join(root, ".gemini", "tmp", agentId);
    const agentChatsDir = path.join(agentTmpDir, "chats");

    // 1. Pre-create chats
    await fs.mkdir(agentChatsDir, { recursive: true });
    await fs.writeFile(path.join(agentChatsDir, "chat-1.jsonl"), "data");

    // 2. Mock fs.cp to fail
    vi.spyOn(fs, "cp").mockRejectedValue(new Error("Copy failed"));

    // 3. Execute
    await execute({
      runId: "run-3",
      agent: { id: agentId, companyId, name: "G", adapterType: "gemini_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: workspace },
      context: {},
      authToken: "t",
      onLog: async () => {},
    });

    // 4. Verify agent directory STILL EXISTS and is a directory (not a symlink)
    const stats = await fs.lstat(agentChatsDir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });
});
