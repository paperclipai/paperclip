// Restart chaos provider-message faults for ACPX agents (Claude): PV1 delay, PV2 drop, PV3 duplicate.
//
// Loaded by the harness's stand-in ACPX sidecar (see ../acpx-provider-faults.ts) inside the real
// sidecar process, before the real sidecar bundle runs. It taps two JSON-lines streams and changes
// only the one message an armed rule names:
//   - "terminal": the provider's ACP `session/prompt` response that follows a `session/cancel` for
//     the same session (the turn's end after a governed wait or a board Stop). This is a real
//     provider message on the sidecar <-> provider pipe.
//   - "interrupt_ack": ACP has no acknowledgement for `session/cancel` (a notification), so this is
//     the sidecar's response to the runner's `turn.cancel` request: the acknowledgement the runner
//     waits for.
// The provider process itself is not changed: it is still launched and admitted by product code.
// Rules, the log and the once-per-task markers are the same files the Codex shim uses.
// Plain Node built-ins only: this runs in the sidecar process, not in the harness.
"use strict";
const { appendFileSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

/** The marker only the verified ACPX provider bootstrap carries (installation-integrity.ts snapshotBootstrap). */
const PROVIDER_BOOTSTRAP_MARKER = "ACPX provider requires verified package snapshots";

function createFaultRuntime(config, now = Date.now) {
  let rules = [];
  let rulesMtimeMs = -1;
  return {
    log(entry) {
      try { appendFileSync(config.logPath, `${JSON.stringify({ at: now(), pid: process.pid, agent: "acpx", ...entry })}\n`); } catch { /* best effort */ }
    },
    armedRules() {
      try {
        const mtimeMs = statSync(config.controlPath).mtimeMs;
        if (mtimeMs !== rulesMtimeMs) {
          rulesMtimeMs = mtimeMs;
          const parsed = JSON.parse(readFileSync(config.controlPath, "utf8"));
          rules = Array.isArray(parsed.rules) ? parsed.rules : [];
        }
      } catch { /* keep the last good rules */ }
      return rules;
    },
    /** Every rule applies at most once per task, across sidecar and provider restarts. */
    claim(rule) {
      const marker = path.join(config.stateDirectory, `${rule.nonce}.${rule.kind}.${rule.message}.applied`);
      try { writeFileSync(marker, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
    },
  };
}

function parse(line) {
  if (!line.startsWith("{")) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function findNonce(runtime, line) {
  for (const rule of runtime.armedRules()) if (typeof rule.nonce === "string" && rule.nonce && line.includes(rule.nonce)) return rule.nonce;
  return null;
}

function matchingRule(runtime, nonce, message, afterInterrupt) {
  if (!nonce) return null;
  return runtime.armedRules().find(rule => rule.nonce === nonce && rule.message === message
    && (afterInterrupt || rule.afterInterrupt === false)) ?? null;
}

/** Apply PV1/PV2/PV3 to one line. Returns true when the rule took the line. */
function createApplier(runtime, layer) {
  const pending = new Map();
  return {
    apply(rule, target, line, emit, requestId) {
      if (!rule || !runtime.claim(rule)) return false;
      const base = { event: "applied", layer, nonce: rule.nonce, kind: rule.kind, message: target.message,
        turnStatus: target.turnStatus ?? null, requestId: requestId ?? null };
      if (rule.kind === "PV2") { runtime.log({ ...base, action: "drop" }); return true; }
      if (rule.kind === "PV3") { emit(line); emit(line); runtime.log({ ...base, action: "duplicate" }); return true; }
      const delayMs = Number(rule.delayMs ?? 0);
      runtime.log({ ...base, action: "delay", delayMs });
      const timer = setTimeout(() => {
        pending.delete(timer);
        emit(line);
        runtime.log({ event: "released", layer, nonce: rule.nonce, kind: rule.kind, message: target.message, delayMs });
      }, delayMs);
      pending.set(timer, { layer, nonce: rule.nonce, kind: rule.kind, message: target.message, delayMs });
      return true;
    },
    /** The stream ended: a held message goes with it, as it would with a dead process. */
    discard() {
      for (const [timer, held] of pending) {
        clearTimeout(timer);
        runtime.log({ event: "held_message_discarded", ...held });
      }
      pending.clear();
    },
  };
}

/**
 * The sidecar <-> provider ACP pipe. `toProvider` sees every line the sidecar sends (prompt, cancel);
 * `fromProvider` decides each line the provider sends.
 */
function createAcpTap(runtime) {
  const applier = createApplier(runtime, "acp");
  const nonceBySession = new Map();
  const prompts = new Map();
  const cancelledSessions = new Set();
  let boundNonce = null;
  const bind = (line, sessionId) => {
    const nonce = findNonce(runtime, line);
    if (!nonce) return;
    if (typeof sessionId === "string") nonceBySession.set(sessionId, nonce);
    if (boundNonce !== nonce) { boundNonce = nonce; runtime.log({ event: "bound", layer: "acp", nonce }); }
  };
  const nonceFor = sessionId => (typeof sessionId === "string" && nonceBySession.get(sessionId)) || boundNonce;
  return {
    toProvider(line) {
      const message = parse(line);
      const sessionId = message?.params?.sessionId;
      bind(line, sessionId);
      if (message?.method === "session/prompt" && message.id !== undefined) {
        // A new prompt: only a cancel of this prompt makes its response a target.
        if (typeof sessionId === "string") cancelledSessions.delete(sessionId);
        prompts.set(JSON.stringify(message.id), typeof sessionId === "string" ? sessionId : null);
      }
      if (message?.method === "session/cancel") {
        if (typeof sessionId === "string") cancelledSessions.add(sessionId);
        runtime.log({ event: "interrupt_requested", layer: "acp", nonce: nonceFor(sessionId), sessionId: sessionId ?? null });
      }
    },
    fromProvider(line, emit) {
      const message = parse(line);
      if (message) bind(line, message.params?.sessionId);
      const key = message && message.method === undefined && message.id !== undefined ? JSON.stringify(message.id) : null;
      if (key === null || !prompts.has(key)) { emit(line); return; }
      const sessionId = prompts.get(key);
      prompts.delete(key);
      const afterInterrupt = sessionId === null ? cancelledSessions.size > 0 : cancelledSessions.has(sessionId);
      const turnStatus = message.result?.stopReason ?? (message.error ? "error" : null);
      const rule = matchingRule(runtime, nonceFor(sessionId), "terminal", afterInterrupt);
      if (!applier.apply(rule, { message: "terminal", turnStatus }, line, emit, message.id)) emit(line);
    },
    ended() { applier.discard(); },
  };
}

/**
 * The runner <-> sidecar pipe. `fromRunner` sees each request frame; `toRunner` decides each frame
 * the sidecar writes.
 */
function createSidecarTap(runtime) {
  const applier = createApplier(runtime, "sidecar");
  const cancelRequests = new Set();
  let boundNonce = null;
  return {
    fromRunner(line) {
      const nonce = findNonce(runtime, line);
      if (nonce && nonce !== boundNonce) { boundNonce = nonce; runtime.log({ event: "bound", layer: "sidecar", nonce }); }
      const message = parse(line);
      if (message?.command === "turn.cancel" && message.id !== undefined) {
        cancelRequests.add(JSON.stringify(message.id));
        runtime.log({ event: "interrupt_requested", layer: "sidecar", nonce: boundNonce, requestId: message.id });
      }
    },
    toRunner(line, emit) {
      const message = parse(line);
      const key = message && message.command === undefined && message.eventType === undefined && message.id !== undefined
        ? JSON.stringify(message.id) : null;
      if (key === null || !cancelRequests.has(key)) { emit(line); return; }
      cancelRequests.delete(key);
      const rule = matchingRule(runtime, boundNonce, "interrupt_ack", true);
      const turnStatus = message.ok === true ? (message.result?.cancelled === true ? "cancelled" : "acknowledged") : "error";
      if (!applier.apply(rule, { message: "interrupt_ack", turnStatus }, line, emit, message.id)) emit(line);
    },
    ended() { applier.discard(); },
  };
}

/** Split a byte or text stream into lines; a decoder keeps a multibyte character that spans two chunks intact. */
function lineSplitter(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line);
      }
    },
    /** Whatever is left without a newline. */
    rest() { const value = buffer + decoder.end(); buffer = ""; return value; },
  };
}

function isVerifiedProviderLaunch(args) {
  return Array.isArray(args) && args.includes("--eval") && args.some(arg => typeof arg === "string" && arg.includes(PROVIDER_BOOTSTRAP_MARKER));
}

/** Put the ACP tap between the sidecar and one provider child. The child's process is untouched. */
function wrapProviderChild(child, tap, runtime) {
  if (!child.stdout || !child.stdin) return;
  const realOutput = child.stdout;
  const output = new PassThrough();
  child.stdout = output;
  if (Array.isArray(child.stdio)) child.stdio[1] = output;
  const outgoing = lineSplitter(line => tap.fromProvider(line, value => { if (!output.destroyed && !output.writableEnded) output.write(`${value}\n`); }));
  realOutput.on("data", chunk => outgoing.push(chunk));
  realOutput.once("end", () => {
    const rest = outgoing.rest();
    tap.ended();
    if (rest && !output.destroyed) output.write(rest);
    output.end();
  });
  realOutput.once("error", error => { tap.ended(); output.destroy(error); });
  // The sidecar closing its side closes the real pipe too.
  output.once("close", () => { if (!realOutput.destroyed) realOutput.destroy(); });
  const incoming = lineSplitter(line => tap.toProvider(line));
  const write = child.stdin.write;
  child.stdin.write = function tappedWrite(chunk, ...rest) {
    try { if (typeof chunk === "string" || chunk instanceof Uint8Array) incoming.push(chunk); } catch { /* observing never blocks a write */ }
    return write.call(this, chunk, ...rest);
  };
  runtime.log({ event: "spawned", layer: "acp", childPid: child.pid ?? null });
}

/** Install both taps in this (sidecar) process, before the real sidecar runs. */
function installAcpxFaultTap(config) {
  const runtime = createFaultRuntime(config);
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = function tappedSpawn(command, args, ...rest) {
    const child = spawn.call(this, command, args, ...rest);
    if (isVerifiedProviderLaunch(args)) {
      try { wrapProviderChild(child, createAcpTap(runtime), runtime); }
      catch (error) { runtime.log({ event: "spawn_failed", layer: "acp", error: String(error) }); }
    }
    return child;
  };
  const sidecar = createSidecarTap(runtime);
  const stdoutWrite = process.stdout.write;
  process.stdout.write = function tappedStdoutWrite(chunk, ...rest) {
    // The sidecar writes one whole frame per call (writeFrame); anything else passes through.
    if (typeof chunk !== "string" || !chunk.endsWith("\n") || chunk.indexOf("\n") !== chunk.length - 1) return stdoutWrite.call(this, chunk, ...rest);
    let result = true;
    let wrote = false;
    sidecar.toRunner(chunk.slice(0, -1), line => {
      const value = `${line}\n`;
      if (!wrote) { wrote = true; result = stdoutWrite.call(process.stdout, value, ...rest); }
      else stdoutWrite.call(process.stdout, value);
    });
    // A held or dropped frame was accepted, as a slow peer would accept it.
    if (!wrote && typeof rest[rest.length - 1] === "function") process.nextTick(rest[rest.length - 1]);
    return result;
  };
  // Observe the runner's requests where the stdin stream receives them, without adding a reader:
  // a 'data' listener would start the flow before the sidecar's own reader is attached.
  const requests = lineSplitter(line => sidecar.fromRunner(line));
  const push = process.stdin.push;
  process.stdin.push = function tappedPush(chunk, ...rest) {
    try { if (chunk !== null && chunk !== undefined) requests.push(chunk); } catch { /* observing never blocks a read */ }
    return push.call(this, chunk, ...rest);
  };
  process.once("exit", () => sidecar.ended());
  runtime.log({ event: "spawned", layer: "sidecar" });
}

module.exports = { PROVIDER_BOOTSTRAP_MARKER, createAcpTap, createFaultRuntime, createSidecarTap, installAcpxFaultTap, isVerifiedProviderLaunch, lineSplitter };
