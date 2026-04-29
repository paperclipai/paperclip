import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAgentEngine } from "../engine.js";

describe("createAgentEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-engine-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers all built-in tools", () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    expect(engine.tools.has("read")).toBe(true);
    expect(engine.tools.has("write")).toBe(true);
    expect(engine.tools.has("edit")).toBe(true);
    expect(engine.tools.has("bash")).toBe(true);
    expect(engine.tools.has("grep")).toBe(true);
    expect(engine.tools.has("find")).toBe(true);
    expect(engine.tools.has("ls")).toBe(true);
  });

  it("builds a system prompt with tool descriptions", () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    const prompt = engine.buildSystemPrompt({
      role: "Test",
      mission: "Test things.",
    });
    expect(prompt).toContain("## read");
    expect(prompt).toContain("## bash");
  });

  it("executes the read tool", async () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello world", "utf-8");

    const result = await engine.executeTool("read", { path: "hello.txt" });
    expect((result as { content: string }).content).toBe("hello world");
  });

  it("executes the write tool", async () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    const result = await engine.executeTool("write", {
      path: "new.txt",
      content: "new content",
    });

    expect((result as { content: string }).content).toContain("Wrote");
    const written = await fs.readFile(path.join(tmpDir, "new.txt"), "utf-8");
    expect(written).toBe("new content");
  });

  it("executes the edit tool", async () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, "edit.txt"), "old text", "utf-8");

    const result = await engine.executeTool("edit", {
      path: "edit.txt",
      oldText: "old text",
      newText: "new text",
    });

    expect((result as { content: string }).content).toContain("Edited");
    const written = await fs.readFile(path.join(tmpDir, "edit.txt"), "utf-8");
    expect(written).toBe("new text");
  });

  it("executes the ls tool", async () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, "a.txt"), "", "utf-8");
    await fs.mkdir(path.join(tmpDir, "subdir"));

    const result = await engine.executeTool("ls", { path: "." });
    const content = (result as { content: string }).content;
    expect(content).toContain("a.txt");
    expect(content).toContain("subdir/");
  });

  it("throws for unknown tools", async () => {
    const engine = createAgentEngine({ cwd: tmpDir });
    await expect(engine.executeTool("unknown", {})).rejects.toThrow(
      'Tool "unknown" is not registered.',
    );
  });

  it("respects timeout", async () => {
    const engine = createAgentEngine({ cwd: tmpDir, toolTimeoutMs: 1 });
    await expect(
      engine.executeTool("bash", { command: "sleep 1" }),
    ).rejects.toThrow('timed out');
  });
});
