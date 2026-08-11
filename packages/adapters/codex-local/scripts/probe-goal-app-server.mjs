#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const command = process.env.CODEX_COMMAND || process.argv[2] || "codex";
const timeoutMs = Number(process.env.CODEX_GOAL_PROBE_TIMEOUT_MS || 20_000);

function fail(message) {
  console.error(`[codex-goal-probe] ${message}`);
  process.exit(1);
}

let child;
try {
  child = spawn(command, ["app-server", "--listen", "stdio://", "--enable", "goals"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (error) {
  fail(`failed to spawn ${command}: ${error instanceof Error ? error.message : String(error)}`);
}

let nextId = 1;
const pending = new Map();
let sawGoalUpdated = false;
let threadId = null;

const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
const rl = readline.createInterface({ input: child.stdout });

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(String(id), { method, resolve, reject });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
}

function answerServerRequest(id, method) {
  child.stdin.write(`${JSON.stringify({
    id,
    error: {
      code: -32601,
      message: `Probe does not implement server request ${method}`,
    },
  })}\n`);
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
    answerServerRequest(message.id, message.method);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    if (message.error) entry.reject(new Error(message.error.message || `${entry.method} failed`));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "thread/started") {
    threadId = message.params?.thread?.id || threadId;
  }
  if (message.method === "thread/goal/updated") {
    sawGoalUpdated = true;
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (error) => fail(`child error: ${error.message}`));
child.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) fail(`codex exited early with ${signal || code}`);
});

try {
  await send("initialize", {
    clientInfo: { name: "paperclip-goal-probe", title: "Paperclip Goal Probe", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized");
  const started = await send("thread/start", { ephemeral: false });
  threadId = threadId || started?.thread?.id || started?.threadId;
  if (!threadId) fail("thread/start did not return a thread id");
  await send("thread/goal/set", {
    threadId,
    objective: "Paperclip Codex goal probe",
    status: "active",
    tokenBudget: 1000,
  });
  const got = await send("thread/goal/get", { threadId });
  if (!got?.goal || got.goal.objective !== "Paperclip Codex goal probe") {
    fail("thread/goal/get did not return the goal that was set");
  }
  await send("thread/goal/clear", { threadId });
  if (!sawGoalUpdated) fail("no thread/goal/updated notification observed");
  clearTimeout(timer);
  child.kill("SIGTERM");
  console.log(JSON.stringify({ ok: true, threadId, sawGoalUpdated }));
} catch (error) {
  clearTimeout(timer);
  child.kill("SIGTERM");
  fail(error instanceof Error ? error.message : String(error));
}
