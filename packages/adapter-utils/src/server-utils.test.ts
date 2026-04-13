import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compressPaperclipWakePayloadForResume,
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  runChildProcess,
  stringifyPaperclipWakePayloadForResume,
} from "./server-utils.js";

// ---------------------------------------------------------------------------
// Wake payload compression
// ---------------------------------------------------------------------------

// Use realistic UUIDs so savings from stripping commentIds are representative.
const COMMENT_ID_1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMMENT_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const ISSUE_ID = "57d632b5-0e97-4565-851b-ac36530a781f";

const sampleFullPayload = {
  reason: "comment",
  issue: {
    id: ISSUE_ID,
    identifier: "PAP-3",
    title: "A2: Wake payload compression — delta-only format",
    status: "in_progress",
    priority: "high",
  },
  executionStage: null,
  commentIds: [COMMENT_ID_1, COMMENT_ID_2],
  latestCommentId: COMMENT_ID_2,
  comments: [
    {
      id: COMMENT_ID_1,
      issueId: ISSUE_ID,
      body: "First comment body",
      bodyTruncated: false,
      createdAt: "2026-04-13T00:00:00.000Z",
      author: { type: "user", id: "user-1" },
    },
    {
      id: COMMENT_ID_2,
      issueId: ISSUE_ID,
      body: "Second comment body",
      bodyTruncated: false,
      createdAt: "2026-04-13T01:00:00.000Z",
      author: { type: "agent", id: "agent-1" },
    },
  ],
  commentWindow: { requestedCount: 2, includedCount: 2, missingCount: 0 },
  truncated: false,
  fallbackFetchNeeded: false,
};

describe("compressPaperclipWakePayloadForResume", () => {
  it("returns null for empty / invalid input", () => {
    expect(compressPaperclipWakePayloadForResume(null)).toBeNull();
    expect(compressPaperclipWakePayloadForResume({})).toBeNull();
  });

  it("retains issue fields for normalization compatibility", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    expect(compressed).not.toBeNull();
    // Issue fields are kept so normalization guards still pass.
    expect(compressed!.issue?.identifier).toBe("PAP-3");
    expect(compressed!.issue?.status).toBe("in_progress");
    expect(compressed!.issue?.priority).toBe("high");
  });

  it("strips commentIds (derivable from inline comments)", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    expect(compressed!.commentIds).toHaveLength(0);
  });

  it("preserves inline comment bodies", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    expect(compressed!.comments).toHaveLength(2);
    expect(compressed!.comments[0].body).toBe("First comment body");
  });

  it("sets compressedForResume flag", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    expect(compressed!.compressedForResume).toBe(true);
  });

  it("compressed JSON is smaller than full JSON", () => {
    const full = JSON.stringify(normalizePaperclipWakePayload(sampleFullPayload));
    const compressed = stringifyPaperclipWakePayloadForResume(sampleFullPayload)!;
    expect(compressed.length).toBeLessThan(full.length);
  });
});

describe("renderPaperclipWakePrompt — compressed resume delta", () => {
  it("omits issue identifier/title line on compressed resume", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    const rendered = renderPaperclipWakePrompt(compressed, { resumedSession: true });
    expect(rendered).not.toContain("PAP-3");
    expect(rendered).not.toContain("delta-only format");
  });

  it("includes reason and comment metadata on compressed resume", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    const rendered = renderPaperclipWakePrompt(compressed, { resumedSession: true });
    expect(rendered).toContain("reason: comment");
    expect(rendered).toContain(`latest comment id: ${COMMENT_ID_2}`);
  });

  it("still includes issue identifier/title on non-compressed resume", () => {
    const rendered = renderPaperclipWakePrompt(sampleFullPayload, { resumedSession: true });
    expect(rendered).toContain("PAP-3");
  });

  it("includes comment bodies in both compressed and full renders", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    const renderedCompressed = renderPaperclipWakePrompt(compressed, { resumedSession: true });
    const renderedFull = renderPaperclipWakePrompt(sampleFullPayload, { resumedSession: true });
    expect(renderedCompressed).toContain("First comment body");
    expect(renderedFull).toContain("First comment body");
  });

  it("compressed rendered prompt is shorter than full rendered prompt on resumed session", () => {
    const compressed = compressPaperclipWakePayloadForResume(sampleFullPayload);
    const renderedCompressed = renderPaperclipWakePrompt(compressed, { resumedSession: true });
    const renderedFull = renderPaperclipWakePrompt(sampleFullPayload, { resumedSession: true });
    expect(renderedCompressed.length).toBeLessThan(renderedFull.length);
  });
});

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
