import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPaperclipWorkerPreflightRequired,
  runPaperclipWorkerPreflight,
  WorkerPreflightError,
} from "../services/worker-preflight.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("worker preflight routing", () => {
  it("requires preflight for the Paperclip OpenCode wrapper", () => {
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "opencode_local",
        config: { command: "/Users/davidai/.local/bin/paperclip-opencode-worker" },
        env: {},
      }),
    ).toBe(true);
  });

  it("requires preflight for the Paperclip OpenClaude wrapper", () => {
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "claude_local",
        config: { command: "/Users/davidai/.local/bin/paperclip-openclaude-worker" },
        env: {},
      }),
    ).toBe(true);
  });

  it("does not gate normal local CLI adapters", () => {
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "opencode_local",
        config: { command: "opencode" },
        env: {},
      }),
    ).toBe(false);
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "claude_local",
        config: { command: "claude" },
        env: {},
      }),
    ).toBe(false);
  });

  it("allows an emergency environment disable", () => {
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "opencode_local",
        config: { command: "/Users/davidai/.local/bin/paperclip-opencode-worker" },
        env: { PAPERCLIP_WORKER_PREFLIGHT_ENABLED: "false" },
      }),
    ).toBe(false);
  });

  it("can be forced for a specific adapter config", () => {
    expect(
      isPaperclipWorkerPreflightRequired({
        adapterType: "opencode_local",
        config: { command: "opencode", paperclipWorkerPreflight: true },
        env: {},
      }),
    ).toBe(true);
  });
});

describe("worker preflight execution", () => {
  it("runs the doctor and logs a pass summary", async () => {
    const doctor = await writeDoctor("printf '23 ok, 0 warn, 0 fail\\n'");
    const logs: string[] = [];

    await runPaperclipWorkerPreflight({
      adapterType: "opencode_local",
      config: { command: "/Users/davidai/.local/bin/paperclip-opencode-worker" },
      env: { PAPERCLIP_WORKER_DOCTOR_BIN: doctor },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(logs.join("")).toContain("Worker preflight passed: 23 ok, 0 warn, 0 fail");
  });

  it("throws a dedicated preflight error when the doctor fails", async () => {
    const doctor = await writeDoctor("printf '22 ok, 0 warn, 1 fail\\n'; exit 7");

    await expect(
      runPaperclipWorkerPreflight({
        adapterType: "claude_local",
        config: { command: "/Users/davidai/.local/bin/paperclip-openclaude-worker" },
        env: { PAPERCLIP_WORKER_DOCTOR_BIN: doctor },
        onLog: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(WorkerPreflightError);
  });
});

async function writeDoctor(body: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worker-doctor-"));
  tempDirs.push(dir);
  const file = path.join(dir, "paperclip-worker-doctor");
  await fs.writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await fs.chmod(file, 0o700);
  return file;
}
