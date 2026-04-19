import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizePaperclipProjectContextPayload,
  renderPaperclipOperatingCadencePrompt,
  renderPaperclipProjectContextPrompt,
  runChildProcess,
  stringifyPaperclipProjectContextPayload,
} from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe("runChildProcess", () => {
  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });
});

describe("renderPaperclipOperatingCadencePrompt", () => {
  it("renders deterministic slow-and-steady token guidance", () => {
    const prompt = renderPaperclipOperatingCadencePrompt();

    expect(prompt).toBe(renderPaperclipOperatingCadencePrompt());
    expect(prompt).toContain("## Paperclip Operating Cadence");
    expect(prompt).toContain("slow, steady, token-conscious work");
    expect(prompt).toContain("issue priority is `critical`");
    expect(prompt).toContain("urgent, ASAP, or immediate");
    expect(prompt).toContain("Keep progress and completion comments concise");
    expect(prompt.length).toBeLessThan(700);
  });
});

describe("Paperclip project context helpers", () => {
  it("keeps goal-only project context payloads available to agents", () => {
    const json = stringifyPaperclipProjectContextPayload({
      projectId: "project-1",
      companyId: "company-1",
      goalMarkdown: "Ship the first working project demo.",
      instructionsMarkdown: "",
      defaultSkillKeys: [],
      sources: [],
      warnings: [],
      generatedAt: "2026-04-19T00:00:00.000Z",
    });

    expect(json).not.toBeNull();
    const normalized = normalizePaperclipProjectContextPayload(JSON.parse(json!));
    expect(normalized?.goalMarkdown).toBe("Ship the first working project demo.");
    expect(normalized?.instructionsMarkdown).toBe("");
  });

  it("renders project goals before instructions and advertises inherited skills", () => {
    const prompt = renderPaperclipProjectContextPrompt({
      projectId: "project-1",
      companyId: "company-1",
      goalMarkdown: "Create a clean board workflow for project-specific work.",
      instructionsMarkdown: "Use local context before external research.",
      defaultSkillKeys: ["design-guide", "design-guide", "qa"],
      sources: [
        {
          sourceId: "source-1",
          itemId: "item-1",
          chunkId: "chunk-1",
          sourceTitle: "Project Notes",
          itemTitle: "Launch Plan",
          uri: "https://example.com/plan",
          excerpt: "Agents should cite project notes when using them.",
        },
      ],
      warnings: [],
      generatedAt: "2026-04-19T00:00:00.000Z",
    });

    expect(prompt).toContain("## Paperclip Project Context");
    expect(prompt).toContain("inherited project skills available to use when useful: design-guide, qa");
    expect(prompt).toContain("Project goal:");
    expect(prompt).toContain("Project instructions:");
    expect(prompt.indexOf("Project goal:")).toBeLessThan(prompt.indexOf("Project instructions:"));
    expect(prompt).toContain("Project Notes / Launch Plan");
  });
});
