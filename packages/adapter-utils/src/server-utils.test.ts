import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendWithByteCap,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  renderPaperclipWakePrompt,
  runChildProcess,
  stringifyPaperclipWakePayload,
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
  it("does not arm a timeout when timeoutSec is 0", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 150);"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done");
  });

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

describe("appendWithByteCap", () => {
  it("keeps valid UTF-8 when trimming through multibyte text", () => {
    const output = appendWithByteCap("prefix ", "hello — world", 7);

    expect(output).not.toContain("\uFFFD");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(7);
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("keeps the default local-agent prompt action-oriented", () => {
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Start actionable work in this heartbeat");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("do not stop at a plan");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Use child issues");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("instead of polling agents, sessions, or processes");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(
      "Respect budget, pause/cancel, approval gates, and company boundaries",
    );
  });

  it("adds the execution contract to scoped wake prompts", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1580",
        title: "Update prompts",
        status: "in_progress",
      },
      commentWindow: {
        requestedCount: 0,
        includedCount: 0,
        missingCount: 0,
      },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("Execution contract: take concrete action in this heartbeat");
    expect(prompt).toContain("use child issues instead of polling");
    expect(prompt).toContain("mark blocked work with the unblock owner/action");
  });

  it("includes continuation and child issue summaries in structured wake context", () => {
    const payload = {
      reason: "issue_children_completed",
      issue: {
        id: "parent-1",
        identifier: "PAP-100",
        title: "Integrate child work",
        status: "in_progress",
        priority: "medium",
      },
      continuationSummary: {
        key: "continuation-summary",
        title: "Continuation Summary",
        body: "# Continuation Summary\n\n## Next Action\n\n- Integrate child outputs.",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        reason: "Run described future work without concrete action evidence",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Implement helper",
          status: "done",
          priority: "medium",
          summary: "Added the helper route and tests.",
        },
      ],
    };

    expect(JSON.parse(stringifyPaperclipWakePayload(payload) ?? "{}")).toMatchObject({
      continuationSummary: {
        body: expect.stringContaining("Continuation Summary"),
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          identifier: "PAP-101",
          summary: "Added the helper route and tests.",
        },
      ],
    });

    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("Issue continuation summary:");
    expect(prompt).toContain("Integrate child outputs.");
    expect(prompt).toContain("Run liveness continuation:");
    expect(prompt).toContain("- attempt: 2/2");
    expect(prompt).toContain("- source run: run-1");
    expect(prompt).toContain("- liveness state: plan_only");
    expect(prompt).toContain("- reason: Run described future work without concrete action evidence");
    expect(prompt).toContain("- instruction: Take the first concrete action now.");
    expect(prompt).toContain("Direct child issue summaries:");
    expect(prompt).toContain("PAP-101 Implement helper (done)");
    expect(prompt).toContain("Added the helper route and tests.");
  });
});
