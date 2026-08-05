import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { matchesLocalProcessIdentity, readLocalProcessIdentity } from "./process-identity.js";

const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

describe.skipIf(process.platform !== "linux")("local process identity", () => {
  it("matches pid start ticks and PAPERCLIP_RUN_ID", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, PAPERCLIP_RUN_ID: "run-identity-test" },
      stdio: "ignore",
    });
    children.add(child);
    if (!child.pid) throw new Error("Expected child pid");

    const identity = await readLocalProcessIdentity(child.pid);
    expect(identity).toMatchObject({ pid: child.pid, runId: "run-identity-test" });
    expect(await matchesLocalProcessIdentity(identity!)).toBe(true);
    expect(await matchesLocalProcessIdentity({ ...identity!, runId: "other-run" })).toBe(false);
    expect(await matchesLocalProcessIdentity({ ...identity!, startTicks: identity!.startTicks + 1 })).toBe(false);
  });
});
