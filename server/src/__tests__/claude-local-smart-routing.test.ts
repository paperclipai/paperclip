import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

/**
 * Fake claude command that appends invocation data to a JSONL capture file.
 * Supports multiple invocations (preflight + primary) in a single test run.
 *
 * When the prompt contains "BOUNDED ORCHESTRATION", the fake emits a preflight-
 * style response with a handoff summary.  Otherwise it emits a normal primary
 * response.  Output uses Claude's stream-json format.
 */
async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const prompt = fs.readFileSync(0, "utf8");
const isPreflight = prompt.includes("BOUNDED ORCHESTRATION");
const payload = {
  argv: process.argv.slice(2),
  prompt,
  isPreflight,
};
if (capturePath) {
  fs.appendFileSync(capturePath, JSON.stringify(payload) + "\\n", "utf8");
}
const sessionId = isPreflight ? "preflight-session-1" : "primary-session-1";
const model = isPreflight ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
const message = isPreflight
  ? "## Handoff Summary\\n\\nThe task requires fixing the login validation bug in auth.ts. Workspace has a standard Node project layout."
  : "Fixed the bug in auth.ts by correcting the validation logic.";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }));
console.log(JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: message }] } }));
console.log(JSON.stringify({ type: "result", session_id: sessionId, result: message, usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 }, total_cost_usd: 0.001 }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

/** Fake claude command that exits with code 1 (simulates preflight failure). */
async function writeFakeClaudeCommandFailPreflight(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const prompt = fs.readFileSync(0, "utf8");
const isPreflight = prompt.includes("BOUNDED ORCHESTRATION");
const payload = { argv: process.argv.slice(2), prompt, isPreflight };
if (capturePath) {
  fs.appendFileSync(capturePath, JSON.stringify(payload) + "\\n", "utf8");
}
if (isPreflight) {
  console.error("rate limit exceeded");
  process.exit(1);
}
const sessionId = "primary-session-1";
const model = "claude-sonnet-4-6";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }));
console.log(JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "Fixed the bug." }] } }));
console.log(JSON.stringify({ type: "result", session_id: sessionId, result: "Fixed the bug.", usage: { input_tokens: 200, cache_read_input_tokens: 0, output_tokens: 100 }, total_cost_usd: 0.005 }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CaptureEntry = {
  argv: string[];
  prompt: string;
  isPreflight: boolean;
};

async function readCaptures(capturePath: string): Promise<CaptureEntry[]> {
  const raw = await fs.readFile(capturePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

type LogEntry = { stream: "stdout" | "stderr"; chunk: string };

function baseAgent() {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Claude Coder",
    adapterType: "claude_local" as const,
    adapterConfig: {},
  };
}

function freshRuntime() {
  return {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  };
}

function resumedRuntime(cwd: string) {
  return {
    sessionId: null,
    sessionParams: { sessionId: "existing-session-1", cwd },
    sessionDisplayId: null,
    taskKey: null,
  };
}

function issueContext() {
  return {
    issueId: "issue-1",
    taskId: "issue-1",
    wakeReason: "issue_commented",
    paperclipWake: {
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-100",
        title: "Fix login bug",
        status: "in_progress",
        priority: "high",
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      comments: [
        {
          id: "comment-1",
          issueId: "issue-1",
          body: "Please fix the login validation",
          bodyTruncated: false,
          createdAt: "2026-04-07T10:00:00.000Z",
          author: { type: "user", id: "user-1" },
        },
      ],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      truncated: false,
      fallbackFetchNeeded: false,
    },
  };
}

describe("claude smart model routing", () => {
  it("runs cheap preflight then primary on fresh issue-scoped sessions with routing enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const logs: LogEntry[] = [];

    try {
      const result = await execute({
        runId: "run-routing-1",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
            cheapThinkingEffort: "low",
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => { logs.push({ stream, chunk }); },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      // Two invocations: preflight + primary
      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(2);

      // First invocation: preflight with cheap model
      const preflight = captures[0]!;
      expect(preflight.isPreflight).toBe(true);
      expect(preflight.argv).toContain("--model");
      expect(preflight.argv[preflight.argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
      expect(preflight.argv).toContain("--effort");
      expect(preflight.argv[preflight.argv.indexOf("--effort") + 1]).toBe("low");
      expect(preflight.prompt).toContain("BOUNDED ORCHESTRATION");
      expect(preflight.prompt).toContain("Do NOT make code changes");

      // Second invocation: primary with primary model
      const primary = captures[1]!;
      expect(primary.isPreflight).toBe(false);
      expect(primary.argv).toContain("--model");
      expect(primary.argv[primary.argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
      expect(primary.prompt).toContain("Continue your Paperclip work.");
      // Primary should contain the preflight handoff
      expect(primary.prompt).toContain("Preflight Summary");
      expect(primary.prompt).toContain("Handoff Summary");

      // Result should contain execution segments
      expect(result.executionSegments).toBeDefined();
      expect(result.executionSegments).toHaveLength(2);
      const cheapSeg = result.executionSegments![0]!;
      const primarySeg = result.executionSegments![1]!;
      expect(cheapSeg.phase).toBe("cheap_preflight");
      expect(cheapSeg.model).toBe("claude-haiku-4-5-20251001");
      expect(cheapSeg.provider).toBe("anthropic");
      expect(cheapSeg.usage?.inputTokens).toBe(100);
      expect(primarySeg.phase).toBe("primary");
      expect(primarySeg.model).toBe("claude-sonnet-4-6");
      expect(primarySeg.provider).toBe("anthropic");

      // Session should be from primary, not preflight
      expect(result.sessionId).toBe("primary-session-1");

      // Logs should mention routing
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Smart routing: running cheap preflight"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Preflight complete"),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips preflight on resumed sessions even with routing enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-resumed-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-routing-resumed",
        agent: baseAgent(),
        runtime: resumedRuntime(workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      // Only one invocation: the resumed session, no preflight
      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(1);
      expect(captures[0]!.isPreflight).toBe(false);
      expect(captures[0]!.argv).toContain("--resume");

      // No execution segments
      expect(result.executionSegments).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips preflight when routing is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-disabled-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-routing-off",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: false,
            cheapModel: "claude-haiku-4-5-20251001",
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      // Only primary invocation
      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(1);
      expect(captures[0]!.isPreflight).toBe(false);

      expect(result.executionSegments).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips preflight when no cheapModel is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-nocheap-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-routing-nocheap",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            // no cheapModel
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(1);
      expect(result.executionSegments).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips preflight when run is not issue-scoped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-noissue-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-routing-noissue",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Do some general work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
          },
        },
        context: {}, // no issue context
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(1);
      expect(result.executionSegments).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("proceeds with primary only when preflight fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-fail-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommandFailPreflight(commandPath);

    const logs: LogEntry[] = [];

    try {
      const result = await execute({
        runId: "run-routing-preflight-fail",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => { logs.push({ stream, chunk }); },
      });

      // Primary should still succeed
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      // Two invocations: failed preflight + successful primary
      const captures = await readCaptures(capturePath);
      expect(captures).toHaveLength(2);
      expect(captures[0]!.isPreflight).toBe(true);
      expect(captures[1]!.isPreflight).toBe(false);

      // Primary prompt should NOT contain preflight handoff (preflight failed)
      expect(captures[1]!.prompt).not.toContain("Preflight Summary");

      // Segment should still report the failed preflight (with null summary)
      expect(result.executionSegments).toBeDefined();
      expect(result.executionSegments).toHaveLength(2);
      expect(result.executionSegments![0]!.phase).toBe("cheap_preflight");
      expect(result.executionSegments![0]!.summary).toBeNull();
      expect(result.executionSegments![1]!.phase).toBe("primary");

      // Logs should note the failure
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("did not produce a handoff"),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses progress-comment instruction by default and allows when configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-routing-comment-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      // Default: comments suppressed
      const result1 = await execute({
        runId: "run-routing-comments-off",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result1.exitCode).toBe(0);
      const captures1 = await readCaptures(capturePath);
      const preflightPrompt1 = captures1[0]!.prompt;
      expect(preflightPrompt1).toContain("Do NOT post comments");

      // Reset capture file
      await fs.writeFile(capturePath, "", "utf8");

      // With allowInitialProgressComment: true
      const result2 = await execute({
        runId: "run-routing-comments-on",
        agent: baseAgent(),
        runtime: freshRuntime(),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Continue your Paperclip work.",
          model: "claude-sonnet-4-6",
          smartModelRouting: {
            enabled: true,
            cheapModel: "claude-haiku-4-5-20251001",
            allowInitialProgressComment: true,
          },
        },
        context: issueContext(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result2.exitCode).toBe(0);
      const captures2 = await readCaptures(capturePath);
      const preflightPrompt2 = captures2[0]!.prompt;
      expect(preflightPrompt2).not.toContain("Do NOT post comments");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
