import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { startNativeRunBriefGate } from "./internal-native-run-brief.js";

const worker = "10000000-0000-4000-8000-000000000001";
it("rejects a read without the per-worker gate capability before recording a receipt", async () => {
  const gate = await startNativeRunBriefGate(worker, Date.now() + 120_000);
  try {
    for (const command of [gate.command.replace(/Bearer [a-f0-9]{64}/, ""), gate.command.replace(/Bearer [a-f0-9]{64}/, "Bearer incorrect")]) {
      const child = spawn("sh", ["-c", command], { stdio: "ignore" });
      expect((await once(child, "exit"))[0]).not.toBe(0);
      expect(gate.calls).toEqual([]);
    }
  } finally { await gate.close(); }
});
it("holds an actual native command until the owned brief becomes available", async () => {
  const gate = await startNativeRunBriefGate(worker, Date.now() + 120_000);
  const child = spawn("sh", ["-c", gate.command], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  const exited = once(child, "exit");
  try {
    await expect.poll(() => gate.calls.length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(child.exitCode).toBeNull(); expect(output).toBe("");
    expect(gate.calls[0]).toMatchObject({ workerId: worker, workerBound: true });
    expect(gate.command).toContain("- Date.now()" );
    gate.release();
    expect((await exited)[0]).toBe(0); expect(output).toContain("The website brief is now available");
  } finally { child.kill("SIGTERM"); await gate.close(); await exited; }
});
it("cleanup stops a pending native read without inventing a successful brief", async () => {
  const gate = await startNativeRunBriefGate(worker, Date.now() + 120_000);
  const child = spawn("sh", ["-c", gate.command], { stdio: "ignore" }); const exited = once(child, "exit");
  try {
    await expect.poll(() => gate.calls.length).toBe(1);
    await gate.close(); expect((await exited)[0]).not.toBe(0);
  } finally { child.kill("SIGTERM"); await gate.close(); await exited; }
});

it("does not give a delayed native command a fresh hold allowance", async () => {
  const gate = await startNativeRunBriefGate(worker, Date.now() + 150);
  await new Promise(resolve => setTimeout(resolve, 180));
  const child = spawn("sh", ["-c", gate.command], { stdio: "ignore" }); const exited = once(child, "exit");
  try { expect((await exited)[0]).not.toBe(0); } finally { child.kill("SIGTERM"); await gate.close(); }
});
it.each([0, -1, NaN, Infinity])("rejects an absent or exhausted original hold clock: %s", async deadline => {
  await expect(startNativeRunBriefGate(worker, deadline)).rejects.toThrow(/deadline/);
});
