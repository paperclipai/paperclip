import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureSupervisor, withFixtureSupervisor } from "./fixture-supervisor.js";

describe("FixtureSupervisor", () => {
  it("cleans partial setup in process-before-root order and remains idempotent", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fixture-supervisor-"));
    const root = path.join(parent, "root");
    await fs.mkdir(root);
    let childPid: number | undefined;

    await expect(
      withFixtureSupervisor({ owner: "partial-setup" }, async (fixtures) => {
        fixtures.registerRoot(root);
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], {
          cwd: root,
          detached: process.platform !== "win32",
          stdio: "ignore",
        });
        childPid = child.pid;
        fixtures.registerProcess(child, {
          label: "partial child",
          processGroupId: process.platform === "win32" ? null : child.pid,
        });
        throw new Error("setup failed");
      }),
    ).rejects.toThrow("setup failed");

    await expect(fs.access(root)).rejects.toThrow();
    const stoppedPid = childPid;
    if (stoppedPid) expect(() => process.kill(stoppedPid, 0)).toThrow();
    await fs.rm(parent, { recursive: true, force: true });
  });

  it("enforces a per-fixture process budget", () => {
    const fixtures = new FixtureSupervisor({ owner: "budgeted", maxProcesses: 1 });
    const fakeChild = { exitCode: 0, signalCode: null } as never;
    fixtures.registerProcess(fakeChild, { label: "first" });
    expect(() => fixtures.registerProcess(fakeChild, { label: "second" })).toThrow(
      /Fixture process budget exceeded for budgeted: 2\/1/,
    );
  });
});
