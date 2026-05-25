import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { ensureCommandResolvable, runChildProcess } = vi.hoisted(() => ({
  ensureCommandResolvable: vi.fn(async () => undefined),
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    runChildProcess,
  };
});

import { agyLocalAdapter } from "../adapters/agy-local.js";

describe("agy_local adapter", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("passes configured extraArgs before the prompt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-agy-adapter-"));
    cleanupDirs.push(cwd);

    await agyLocalAdapter.execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Research Lead",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd,
        extraArgs: ["--add-dir", "/tmp/secondary-repo"],
      },
      context: {},
      onLog: async () => undefined,
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[1]).toBe("agy");
    expect(call?.[2].slice(0, -1)).toEqual([
      "--print",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/secondary-repo",
    ]);
    expect(call?.[2].at(-1)).toContain("You are");
  });
});
