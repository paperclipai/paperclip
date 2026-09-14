import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readProcessStartedAt } from "../hot-restart.js";
import { createLocalProcessHandoff } from "./local-process-handoff.js";

const supported = ["darwin", "linux"].includes(process.platform);
describe.skipIf(!supported)("verified local command process handoff", () => {
  let root: string;
  const children: ChildProcess[] = [];
  const handoff = createLocalProcessHandoff();
  beforeAll(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-handoff-"))); });
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      await exited;
    }
  });
  afterAll(async () => { await fs.rm(root, { force: true, recursive: true }); });
  async function command(options: { detached?: boolean; cwd?: string; leaf?: boolean; children?: number; ignoreTerm?: boolean } = {}) {
    const script = options.leaf
      ? `const {spawn}=require('node:child_process');const children=Array.from({length:${options.children ?? 1}},()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));console.log(JSON.stringify({pid:process.pid,leaf:children[0].pid}));setInterval(()=>{},1000);`
      : `${options.ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script], { cwd: options.cwd ?? root, detached: options.detached !== false, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
    // Track only independent fixture groups; a non-detached child must never
    // cause cleanup to signal the test runner's own process group.
    if (options.detached !== false) children.push(child);
    const [chunk] = await once(child.stdout!, "data");
    const output = JSON.parse(String(chunk)) as { pid: number; leaf?: number };
    const input = { pid: output.pid, owner: { pid: process.pid, startedAt: (await readProcessStartedAt(process.pid))! }, cwd: root, workspaceRoot: root };
    return { child, input, output };
  }

  it("captures an owned independent command and idempotently confirms its exit", async () => {
    const f = await command(); const proof = await handoff.captureExistingProcess(f.input);
    expect(proof.key).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.receipt).not.toHaveProperty("env");
    const exited = once(f.child, "exit");
    await handoff.stopExistingProcess(proof.receipt); await exited;
    await handoff.stopExistingProcess(proof.receipt);
  });
  it("keeps unproved owner, source directory and control-plane processes untouched", async () => {
    const f = await command();
    await expect(handoff.captureExistingProcess({ ...f.input, owner: { ...f.input.owner, startedAt: "2000-01-01T00:00:00.000Z" } })).rejects.toMatchObject({ code: "process_ownership_unverified" });
    await expect(handoff.captureExistingProcess({ ...f.input, pid: process.pid })).rejects.toMatchObject({ code: "process_ownership_unverified" });
    const other = path.join(root, "other"); await fs.mkdir(other);
    await expect(handoff.captureExistingProcess({ ...f.input, cwd: other, workspaceRoot: other })).rejects.toMatchObject({ code: "process_ownership_unverified" });
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  });
  it("does not mistake an unrelated command for the claimed run's descendant", async () => {
    const source = await command(); const other = await command();
    await expect(handoff.captureExistingProcess({ ...source.input, owner: { pid: other.child.pid!, startedAt: (await readProcessStartedAt(other.child.pid!))! } })).rejects.toMatchObject({ code: "process_ownership_unverified" });
    expect(source.child.signalCode).toBeNull(); expect(other.child.signalCode).toBeNull();
  });
  it("refuses a child listener so registering it cannot terminate its siblings", async () => {
    const f = await command({ leaf: true });
    await expect(handoff.captureExistingProcess({ ...f.input, pid: f.output.leaf! })).rejects.toMatchObject({ code: "process_ownership_unverified" });
    const proof = await handoff.captureExistingProcess(f.input);
    await handoff.stopExistingProcess(proof.receipt);
  });
  it("refuses a process sharing the agent's process group", async () => {
    const f = await command({ detached: false });
    try { await expect(handoff.captureExistingProcess(f.input)).rejects.toMatchObject({ code: "process_ownership_unverified" }); }
    finally { const exited = once(f.child, "exit"); f.child.kill("SIGKILL"); await exited; }
  });
  it("confirms shutdown while children disappear during process identity reads", async () => {
    // Vite's parent and esbuild children can exit within a single ps/identity
    // observation. Repeated real groups exercise that scheduling boundary.
    for (let attempt = 0; attempt < 20; attempt++) {
      const f = await command({ leaf: true, children: 5 });
      const proof = await handoff.captureExistingProcess(f.input);
      await handoff.stopExistingProcess(proof.receipt);
      await handoff.stopExistingProcess(proof.receipt);
    }
  }, 30_000);
  it("never signals a receipt from another host or with reused process identities", async () => {
    const f = await command(); const proof = await handoff.captureExistingProcess(f.input);
    await expect(handoff.stopExistingProcess({ ...proof.receipt, host: "0".repeat(64) })).rejects.toMatchObject({ code: "process_handoff_unverified" });
    await expect(handoff.stopExistingProcess({ ...proof.receipt, leaderIdentity: "different" })).rejects.toMatchObject({ code: "process_handoff_unverified" });
    await expect(handoff.stopExistingProcess({ ...proof.receipt, members: [...(proof.receipt.members as unknown[]), ...(proof.receipt.members as unknown[])] })).rejects.toMatchObject({ code: "process_handoff_unverified" });
    await expect(handoff.stopExistingProcess({ ...proof.receipt, leaderIdentity: "reused", members: [{ pid: f.child.pid, identity: "reused" }] })).rejects.toMatchObject({ code: "process_handoff_unverified" });
    expect(f.child.signalCode).toBeNull();
  });
  it("escalates only the same verified group when it ignores graceful termination", async () => {
    const f = await command({ ignoreTerm: true }); const proof = await handoff.captureExistingProcess(f.input);
    const exited = once(f.child, "exit"); await handoff.stopExistingProcess(proof.receipt); await exited;
    expect(f.child.signalCode).toBe("SIGKILL");
  }, 15_000);
});
