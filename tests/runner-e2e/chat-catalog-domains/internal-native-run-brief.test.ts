import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { startNativeRunBriefGate } from "./internal-native-run-brief.js";

const worker = "10000000-0000-4000-8000-000000000001";
it("keeps the registered gate credential out of task and run evidence", async () => {
  const secrets: string[] = [];
  const gate = await startNativeRunBriefGate(worker, Date.now() + 120_000, secrets);
  try {
    expect(secrets).toHaveLength(1);
    expect(gate.command).not.toContain(secrets[0]);
    expect(gate.command).not.toContain("Bearer");
    expect((await stat(gate.scriptPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(gate.scriptPath, "utf8")).toContain(secrets[0]);
  } finally { await gate.close(); }
  await expect(stat(gate.scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects a read without the per-worker gate capability before recording a receipt", async () => {
  const gate = await startNativeRunBriefGate(worker, Date.now() + 120_000);
  try {
    const script = await readFile(gate.scriptPath, "utf8");
    const url = JSON.parse(script.match(/get\(("[^"]+")/)![1]!);
    for (const headers of [new Headers(), new Headers({ authorization: "Bearer incorrect" })]) {
      expect((await fetch(url, { headers })).status).toBe(401);
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
    expect(await readFile(gate.scriptPath, "utf8")).toContain("- Date.now()" );
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
