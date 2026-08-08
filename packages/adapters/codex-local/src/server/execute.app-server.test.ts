import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintCodexGoalObjective } from "./app-server/index.js";
import { execute } from "./execute.js";

type Capture = {
  argv: string[];
  paperclipApiKey: string | null;
  paperclipApiBridgeMode: string | null;
  methods: string[];
  responses: Array<Record<string, unknown>>;
  prompt: string | null;
};

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function writeFakeCodexAppServer(
  commandPath: string,
  options: {
    status?: "complete" | "blocked" | "usageLimited";
    unsupportedGoalSet?: boolean;
  } = {},
) {
  const status = options.status ?? "complete";
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.0.0-test");
  process.exit(0);
}

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
let threadId = "thread-goal-1";
let turnId = "turn-goal-1";
let prompt = null;
const methods = [];
const responses = [];

function capture() {
  if (!capturePath) return;
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    paperclipApiKey: process.env.PAPERCLIP_API_KEY || null,
    paperclipApiBridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE || null,
    methods,
    responses,
    prompt,
  }), "utf8");
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function result(id, value) {
  send({ id, result: value });
}

function emitGoal(goal) {
  send({ method: "thread/goal/updated", params: { threadId, turnId, goal } });
}

let serverRequestId = 1000;
function serverRequest(method) {
  send({ id: serverRequestId++, method, params: { prompt: "approve?" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    methods.push(message.method);
  } else if (message.id) {
    responses.push(message);
    capture();
    return;
  }
  capture();
  switch (message.method) {
    case "initialize":
      result(message.id, {});
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      result(message.id, { thread: { id: threadId } });
      break;
    case "thread/resume":
      threadId = message.params?.threadId || threadId;
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      result(message.id, { thread: { id: threadId } });
      break;
    case "turn/start":
      prompt = message.params?.input?.[0]?.text || null;
      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      serverRequest("item/commandExecution/requestApproval");
      serverRequest("item/tool/requestUserInput");
      serverRequest("paperclip/unknownServerRequest");
      result(message.id, { turn: { id: turnId } });
      break;
    case "thread/goal/set": {
      if (${JSON.stringify(options.unsupportedGoalSet === true)}) {
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
        break;
      }
      const activeGoal = {
        threadId,
        objective: message.params.objective || "goal",
        status: message.params.status || "active",
        tokenBudget: message.params.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      emitGoal(activeGoal);
      result(message.id, { goal: activeGoal });
      if (activeGoal.status === "active") {
        setTimeout(() => {
          const finalGoal = {
            ...activeGoal,
            status: ${JSON.stringify(status)},
            tokensUsed: 42,
            timeUsedSeconds: 3,
            updatedAt: 2,
          };
          send({ method: "item/completed", params: { threadId, turnId, item: { id: "msg-1", type: "agentMessage", text: "goal done" } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId }, usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } } });
          emitGoal(finalGoal);
          capture();
        }, 20);
      }
      break;
    }
    case "thread/goal/get":
      result(message.id, { goal: { threadId, objective: message.params?.objective || "goal", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, updatedAt: 1 } });
      break;
    case "thread/goal/clear":
      send({ method: "thread/goal/cleared", params: { threadId } });
      threadId = "thread-goal-1";
      result(message.id, {});
      break;
    default:
      result(message.id, {});
      break;
  }
});

process.on("SIGTERM", () => {
  capture();
  process.exit(0);
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

function baseExecuteInput(root: string, commandPath: string, capturePath: string) {
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  return {
    workspace,
    codexHome,
    input: {
      runId: "run-goal",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: commandPath,
        cwd: workspace,
        runtime: "app_server_experimental",
        goal: { enabled: true, tokenBudget: 123 },
        env: {
          CODEX_HOME: codexHome,
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
        },
        promptTemplate: "Do the assigned work.",
      },
      context: {
        taskId: "issue-1",
        paperclipWake: {
          issue: {
            id: "issue-1",
            identifier: "PAP-12601",
            title: "Port goal runtime",
          },
        },
      },
      authToken: "run-jwt-token",
      onLog: async () => {},
    },
  };
}

async function prepareFixture(status: "complete" | "blocked" | "usageLimited" = "complete") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-app-server-"));
  cleanupDirs.push(root);
  const commandPath = path.join(root, "codex");
  const capturePath = path.join(root, "capture.json");
  const { workspace, codexHome, input } = baseExecuteInput(root, commandPath, capturePath);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}", "utf8");
  await writeFakeCodexAppServer(commandPath, { status });
  return { capturePath, input };
}

async function prepareUnsupportedGoalSetFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-app-server-unsupported-"));
  cleanupDirs.push(root);
  const commandPath = path.join(root, "codex");
  const capturePath = path.join(root, "capture.json");
  const { workspace, codexHome, input } = baseExecuteInput(root, commandPath, capturePath);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}", "utf8");
  await writeFakeCodexAppServer(commandPath, { unsupportedGoalSet: true });
  return { capturePath, input };
}

describe("codex app-server goal runtime", () => {
  it("spawns app-server goal mode, strips Paperclip API credentials, answers server requests, and stores app-server session metadata", async () => {
    const { capturePath, input } = await prepareFixture();
    const result = await execute(input);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("thread-goal-1");
    expect(result.sessionParams).toMatchObject({
      sessionId: "thread-goal-1",
      protocol: "app_server",
      features: ["goal"],
      issueId: "issue-1",
    });
    expect(result.resultJson?.codexGoal).toMatchObject({
      status: "complete",
      tokensUsed: 42,
      tokenBudget: 123,
    });

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
    expect(capture.argv).toEqual(["app-server", "--listen", "stdio://", "--enable", "goals"]);
    expect(capture.paperclipApiKey).toBeNull();
    expect(capture.paperclipApiBridgeMode).toBeNull();
    expect(capture.methods).toEqual(expect.arrayContaining(["initialize", "thread/start", "turn/start", "thread/goal/set"]));
    expect(capture.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ result: expect.objectContaining({ approved: false }) }),
      expect.objectContaining({ result: expect.objectContaining({ canceled: true }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: -32601 }) }),
    ]));
  });

  it("handles /goal status without starting a model turn", async () => {
    const { capturePath, input } = await prepareFixture();
    const result = await execute({
      ...input,
      runtime: {
        sessionId: "thread-goal-1",
        sessionParams: {
          sessionId: "thread-goal-1",
          protocol: "app_server",
          features: ["goal"],
          issueId: "issue-1",
        },
        sessionDisplayId: "thread-goal-1",
        taskKey: null,
      },
      context: {
        ...input.context,
        paperclipChatCommand: {
          name: "goal",
          raw: "/goal status",
          args: "status",
          sourceCommentId: "comment-1",
          sourceAuthorType: "user",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toContain("Goal status: active");
    expect(result.resultJson?.chatCommand).toMatchObject({ name: "goal", action: "status" });

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
    expect(capture.methods).toEqual(expect.arrayContaining(["initialize", "thread/resume", "thread/goal/get"]));
    expect(capture.methods).not.toContain("turn/start");
    expect(capture.prompt).toBeNull();
  });

  it("handles /goal set with the user-supplied objective", async () => {
    const { capturePath, input } = await prepareFixture();
    const result = await execute({
      ...input,
      context: {
        ...input.context,
        paperclipChatCommand: {
          name: "goal",
          raw: "/goal ship the feature",
          args: "ship the feature",
          sourceCommentId: "comment-1",
          sourceAuthorType: "user",
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Goal set: ship the feature");
    expect(result.sessionParams).toMatchObject({
      protocol: "app_server",
      features: ["goal"],
      issueId: "issue-1",
    });

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
    expect(capture.methods).toEqual(expect.arrayContaining(["thread/start", "thread/goal/set"]));
    expect(capture.methods).not.toContain("turn/start");
  });

  it("refuses to resume a saved goal session when the live objective fingerprint mismatches", async () => {
    const { capturePath, input } = await prepareFixture();
    const expectedObjective = "Complete Paperclip issue PAP-12601 Port goal runtime.";
    const result = await execute({
      ...input,
      runtime: {
        sessionId: "thread-goal-stale",
        sessionParams: {
          sessionId: "thread-goal-stale",
          protocol: "app_server",
          features: ["goal"],
          issueId: "issue-1",
          objectiveFingerprint: fingerprintCodexGoalObjective(expectedObjective),
        },
        sessionDisplayId: "thread-goal-stale",
        taskKey: null,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("thread-goal-1");

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
    expect(capture.methods).toEqual(expect.arrayContaining([
      "thread/resume",
      "thread/goal/get",
      "thread/goal/clear",
      "thread/start",
      "thread/goal/set",
    ]));
  });

  it("maps blocked and usageLimited goal statuses to terminal error codes instead of waiting for timeout", async () => {
    const blocked = await prepareFixture("blocked");
    const blockedResult = await execute(blocked.input);
    expect(blockedResult.exitCode).toBe(1);
    expect(blockedResult.errorCode).toBe("codex_goal_blocked");

    const usageLimited = await prepareFixture("usageLimited");
    const usageResult = await execute(usageLimited.input);
    expect(usageResult.exitCode).toBe(1);
    expect(usageResult.errorCode).toBe("codex_goal_usage_limited");
  });

  it("refuses goal mode on remote execution targets", async () => {
    const { input } = await prepareFixture();
    const result = await execute({
      ...input,
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        runner: { execute: async () => { throw new Error("should not run"); } },
      },
    });

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("codex_goal_remote_unsupported");
  });

  it("maps missing thread/goal/set support to codex_goal_unsupported_cli", async () => {
    const { capturePath, input } = await prepareUnsupportedGoalSetFixture();
    const result = await execute(input);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("codex_goal_unsupported_cli");
    expect(result.errorMessage).toContain("does not support thread/goal/set");

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
    expect(capture.methods).toEqual(expect.arrayContaining(["thread/goal/set"]));
  });
});
