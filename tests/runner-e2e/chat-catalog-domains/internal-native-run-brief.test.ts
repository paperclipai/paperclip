import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { NATIVE_BRIEF_HOLD_MS, startNativeRunBriefGate } from "./internal-native-run-brief.js";

const worker = "10000000-0000-4000-8000-000000000001";
it("holds an actual native command until the owned brief becomes available", async () => {
  const gate = await startNativeRunBriefGate(worker);
  const child = spawn("sh", ["-c", gate.command], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  const exited = once(child, "exit");
  try {
    await expect.poll(() => gate.calls.length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(child.exitCode).toBeNull(); expect(output).toBe("");
    expect(gate.calls[0]).toMatchObject({ workerId: worker, workerBound: true });
    expect(gate.command).toContain(`AbortSignal.timeout(${NATIVE_BRIEF_HOLD_MS})`);
    gate.release();
    expect((await exited)[0]).toBe(0); expect(output).toContain("The website brief is now available");
  } finally { child.kill("SIGTERM"); await gate.close(); await exited; }
});
it("cleanup stops a pending native read without inventing a successful brief", async () => {
  const gate = await startNativeRunBriefGate(worker);
  const child = spawn("sh", ["-c", gate.command], { stdio: "ignore" }); const exited = once(child, "exit");
  try {
    await expect.poll(() => gate.calls.length).toBe(1);
    await gate.close(); expect((await exited)[0]).not.toBe(0);
  } finally { child.kill("SIGTERM"); await gate.close(); await exited; }
});
