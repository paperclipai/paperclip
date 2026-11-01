import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { cleanupControllerSmokeDatabase } from "./controller-smoke-cleanup.js";

it("does not certify cleanup while the owned database process is still alive", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const cleanup = vi.fn(async () => {});
  try {
    await expect(cleanupControllerSmokeDatabase({ cleanup }, child.pid!, 30)).rejects.toThrow("owned_postgres_exit_unconfirmed");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    await expect(cleanupControllerSmokeDatabase({ cleanup }, child.pid!, 30)).resolves.toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
});

it("preserves cleanup failures and refuses an unknown embedded process identity", async () => {
  await expect(cleanupControllerSmokeDatabase({ cleanup: async () => { throw new Error("drop_failed"); } }, null))
    .rejects.toThrow("drop_failed");
  await expect(cleanupControllerSmokeDatabase({ cleanup: async () => {} }, undefined))
    .rejects.toThrow("owned_postgres_identity_unavailable");
});

it("accepts confirmed external database deletion without stopping its shared cluster", async () => {
  const cleanup = vi.fn(async () => {});
  await expect(cleanupControllerSmokeDatabase({ cleanup }, null)).resolves.toBeUndefined();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
