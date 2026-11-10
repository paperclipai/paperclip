#!/usr/bin/env node
// Restart chaos provider-message fault shim (PV1 delay, PV2 drop, PV3 duplicate).
//
// The harness installs this file as the `codex` executable of a stand-in
// `@openai/codex` package (see ../provider-faults.ts). It starts the real Codex
// command with the same arguments and relays its JSON-lines stdio unchanged,
// except for the one provider message an armed rule names:
//   - "terminal": the `turn/completed` notification that follows a `turn/interrupt`
//     request (a governed wait or a board Stop);
//   - "interrupt_ack": the response to that `turn/interrupt` request.
// Rules are armed per task in the control file, by the task's nonce. A process is
// bound to a nonce once the nonce appears in its traffic (the task's prompt or a
// tool result). Every rule applies at most once per task (an exclusive marker file
// survives provider restarts). Every decision is appended to the log file.
// Plain Node built-ins only: this runs in the provider process, not the harness.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shim-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const startedAt = Date.now();

function log(entry) {
  try { appendFileSync(config.logPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`); } catch { /* best effort */ }
}

let rules = [];
let rulesMtimeMs = -1;
function armedRules() {
  try {
    const mtimeMs = statSync(config.controlPath).mtimeMs;
    if (mtimeMs !== rulesMtimeMs) {
      rulesMtimeMs = mtimeMs;
      const parsed = JSON.parse(readFileSync(config.controlPath, "utf8"));
      rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    }
  } catch { /* keep the last good rules */ }
  return rules;
}

let boundNonce = null;
const nonceByThread = new Map();
const interruptRequestIds = new Map();
const interruptedThreads = new Set();
let interruptSeen = false;

function findNonce(line) {
  for (const rule of armedRules()) if (typeof rule.nonce === "string" && rule.nonce && line.includes(rule.nonce)) return rule.nonce;
  return null;
}

function bindFrom(line, message) {
  const nonce = findNonce(line);
  if (!nonce) return;
  const threadId = message?.params?.threadId;
  if (typeof threadId === "string") nonceByThread.set(threadId, nonce);
  if (boundNonce !== nonce) { boundNonce = nonce; log({ event: "bound", nonce }); }
}

function parse(line) {
  if (!line.startsWith("{")) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function claim(rule) {
  const marker = path.join(config.stateDirectory, `${rule.nonce}.${rule.kind}.${rule.message}.applied`);
  try { writeFileSync(marker, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}

const child = spawn(config.realCommand, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
log({ event: "spawned", childPid: child.pid ?? null, args: process.argv.slice(2).filter(arg => arg === "app-server" || arg === "--version") });

// Parent -> provider: relayed byte for byte; read only to bind and to see interrupts.
// A decoder per stream keeps a multibyte character that spans two chunks intact.
const inputDecoder = new StringDecoder("utf8");
let inputBuffer = "";
process.stdin.on("data", chunk => {
  child.stdin.write(chunk);
  inputBuffer += inputDecoder.write(chunk);
  let newline;
  while ((newline = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    const message = parse(line);
    bindFrom(line, message);
    if (message?.method === "turn/start") {
      // A new turn: only an interrupt of this turn makes its terminal a target.
      interruptSeen = false;
      if (typeof message.params?.threadId === "string") interruptedThreads.delete(message.params.threadId);
    }
    if (message?.method === "turn/interrupt") {
      interruptSeen = true;
      if (message.id !== undefined) interruptRequestIds.set(JSON.stringify(message.id), message.params?.threadId ?? null);
      if (typeof message.params?.threadId === "string") interruptedThreads.add(message.params.threadId);
      log({ event: "interrupt_requested", nonce: boundNonce, requestId: message.id ?? null });
    }
  }
});
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => undefined);

/** Held PV1 messages: timer -> the rule it belongs to. */
const pendingTimers = new Map();
function emit(line) { process.stdout.write(`${line}\n`); }

function classify(message) {
  if (!message) return null;
  if (message.method === "turn/completed") {
    const threadId = message.params?.threadId;
    const afterInterrupt = typeof threadId === "string" && interruptedThreads.size ? interruptedThreads.has(threadId) : interruptSeen;
    return { message: "terminal", afterInterrupt, threadId: typeof threadId === "string" ? threadId : null,
      turnStatus: message.params?.turn?.status ?? null };
  }
  if (message.method === undefined && message.id !== undefined && interruptRequestIds.has(JSON.stringify(message.id))) {
    return { message: "interrupt_ack", afterInterrupt: true, threadId: interruptRequestIds.get(JSON.stringify(message.id)), turnStatus: null };
  }
  return null;
}

function ruleFor(target) {
  const nonce = (target.threadId && nonceByThread.get(target.threadId)) || boundNonce;
  if (!nonce) return null;
  return armedRules().find(rule => rule.nonce === nonce && rule.message === target.message
    && (target.afterInterrupt || rule.afterInterrupt === false)) ?? null;
}

function relay(line) {
  const message = parse(line);
  if (message) bindFrom(line, message);
  const target = classify(message);
  const rule = target ? ruleFor(target) : null;
  if (!target || !rule || !claim(rule)) { emit(line); return; }
  const base = { event: "applied", nonce: rule.nonce, kind: rule.kind, message: target.message, turnStatus: target.turnStatus,
    requestId: message.id ?? null, sinceSpawnMs: Date.now() - startedAt };
  if (rule.kind === "PV2") { log({ ...base, action: "drop" }); return; }
  if (rule.kind === "PV3") { emit(line); emit(line); log({ ...base, action: "duplicate" }); return; }
  const delayMs = Number(rule.delayMs ?? 0);
  log({ ...base, action: "delay", delayMs });
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    emit(line);
    log({ event: "released", nonce: rule.nonce, kind: rule.kind, message: target.message, delayMs });
  }, delayMs);
  pendingTimers.set(timer, { nonce: rule.nonce, kind: rule.kind, message: target.message, delayMs });
}

const outputDecoder = new StringDecoder("utf8");
let outputBuffer = "";
child.stdout.on("data", chunk => {
  outputBuffer += outputDecoder.write(chunk);
  let newline;
  while ((newline = outputBuffer.indexOf("\n")) >= 0) {
    const line = outputBuffer.slice(0, newline);
    outputBuffer = outputBuffer.slice(newline + 1);
    relay(line);
  }
});
child.stdout.on("end", () => {
  outputBuffer += outputDecoder.end();
  if (outputBuffer) { process.stdout.write(outputBuffer); outputBuffer = ""; }
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}

child.on("error", error => {
  log({ event: "spawn_failed", error: String(error) });
  process.stderr.write(`restart-chaos codex shim: ${error.message}\n`);
  process.exit(127);
});
// "close": the provider exited and its stdout is fully relayed.
child.on("close", (code, signal) => {
  // A provider that exits takes its held messages with it, as a dead provider would.
  for (const [timer, held] of pendingTimers) {
    clearTimeout(timer);
    log({ event: "held_message_discarded", ...held });
  }
  pendingTimers.clear();
  log({ event: "exited", code, signal });
  const finish = () => process.exit(code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : signal === "SIGINT" ? 2 : 15) : 1));
  if (process.stdout.writableNeedDrain) process.stdout.once("drain", finish); else finish();
});
