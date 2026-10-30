import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown>, onLog: (stream: string, chunk: string) => void) {
  return {
    runId: "test-run-skills",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...config,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async (stream: string, chunk: string) => onLog(stream, chunk)),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof execute>[0];
}

describe("hermes-local adapter: the skills cannot be reconciled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the failure with the no-provider-work proof instead of throwing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-skills-"));
    try {
      const source = path.join(home, "materialised", "demo");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: demo\n---\n", "utf8");
      await fs.mkdir(path.join(home, "skills", "demo--1234"), { recursive: true });

      const logs: string[] = [];
      const result = await execute(
        makeCtx(
          {
            env: { HERMES_HOME: home },
            paperclipRuntimeSkills: [
              { key: "company-1/demo", runtimeName: "demo--1234", source },
            ],
            paperclipSkillSync: { desiredSkills: ["company-1/demo"] },
          },
          (stream, chunk) => logs.push(`${stream}: ${chunk}`),
        ),
      );

      expect(result.executionRecovery).toEqual({
        kind: "bootstrap",
        providerWorkStarted: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("Hermes cannot start");
      expect(logs.join("\n")).toContain("Cannot start without the required Paperclip-managed skills");
      expect(runChildProcess).not.toHaveBeenCalled();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
