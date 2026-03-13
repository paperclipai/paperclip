import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeLockCheck } from "../checks/runtime-lock-check.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup.splice(0)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
});

function setupHome(instanceId = "default"): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  cleanup.push(home);
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  fs.mkdirSync(path.join(home, "instances", instanceId), { recursive: true });
  return home;
}

describe("runtimeLockCheck", () => {
  it("passes when no lock file", () => {
    setupHome();
    const r = runtimeLockCheck();
    expect(r.status).toBe("pass");
  });

  it("warns and repair removes stale lock", async () => {
    const home = setupHome();
    const lock = path.join(home, "instances", "default", "run.lock.json");
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), "utf8");

    const r = runtimeLockCheck();
    expect(r.status).toBe("warn");
    expect(typeof r.repair).toBe("function");
    await r.repair?.();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("warns on live lock", () => {
    const home = setupHome();
    const lock = path.join(home, "instances", "default", "run.lock.json");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

    const r = runtimeLockCheck();
    expect(r.status).toBe("warn");
    expect(r.message).toContain("active");
  });
});
