/** Explicit slow control: node --import ./cli/node_modules/tsx/dist/loader.mjs tests/runner-e2e/chat-catalog-domains/verify-native-brief-clock.ts --five-minute-control */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { startNativeRunBriefGate } from "./internal-native-run-brief.js";

if (!process.argv.includes("--five-minute-control")) throw new Error("Use --five-minute-control to run the 310-second native lifetime check");
const started = Date.now(), holdMs = 310_000, deadlineMs = 340_000;
const gate = await startNativeRunBriefGate("10000000-0000-4000-8000-000000000001", started + deadlineMs);
const child = spawn("sh", ["-c", gate.command], { stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
try {
  while (!gate.calls.length && Date.now() - started < 5000 && child.exitCode === null) await delay(20);
  assert.equal(gate.calls.length, 1, "The actual native worker must reach the owned brief gate");
  console.log(JSON.stringify({ stage: "native-read-held", node: process.version, holdMs, deadlineMs }));
  await delay(holdMs);
  assert.equal(child.exitCode, null, "The native read must survive the five-minute header timeout");
  assert.equal(output, "", "The pending brief must not produce a premature result");
  gate.release();
  assert.equal((await exited)[0], 0);
  assert.ok(output.includes("The website brief is now available"));
  console.log(JSON.stringify({ status: "passed", elapsedMs: Date.now() - started, holdMs, deadlineMs }));
} finally {
  child.kill("SIGTERM");
  await gate.close();
  await exited;
}
