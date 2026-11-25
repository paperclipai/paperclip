import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { usesOpenCodeV2 } from "./version.js";

it("probes the version through the sandbox runner in its assigned workspace", async () => {
  const execute = vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, stdout: "opencode v2.3.2", stderr: "",
    pid: null, startedAt: "2020-01-01T00:00:00.000Z", durationMs: 1,
  }));
  const target = {
    kind: "remote", transport: "sandbox", providerKey: "fixture",
    remoteCwd: "/workspace/realized", runner: { execute },
  } as const;

  await expect(usesOpenCodeV2({
    runId: "fixture", target, command: "opencode", cwd: "/workspace/realized",
    env: { PATH: "/bin" }, timeoutSec: 3,
  })).resolves.toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    command: "opencode", args: ["--version"], cwd: "/workspace/realized", timeoutMs: 3000,
  }));
});

it("stops after cancellation while a version probe is running", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-version-cancel-"));
  const command = path.join(cwd, "opencode");
  await fs.writeFile(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await expect(usesOpenCodeV2({
      runId: "fixture-cancel", target: null, command, cwd,
      env: { PATH: process.env.PATH ?? "" }, timeoutSec: 0.2, signal: controller.signal,
    })).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
