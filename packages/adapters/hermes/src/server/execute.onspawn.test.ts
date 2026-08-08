/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const hermesTestState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
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

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (filePath: string) => hermesTestState.files.get(String(filePath)) ?? ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
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
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hermesTestState.files.clear();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("makes the stored profile authoritative and filters reserved passthrough flags", async () => {
    const { ctx } = makeCtx({
      profile: "paperclip-local-v2",
      extraArgs: [
        "--profile", "other",
        "-p", "other-short",
        "--profile=other-equals",
        "-p=other-short-equals",
        "--skills", "other-skill",
        "-s", "other-short-skill",
        "--skills=other-equals-skill",
        "-s=other-short-equals-skill",
        "--keep", "value",
      ],
    });

    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(args.slice(0, 3)).toEqual(["--profile", "paperclip-local-v2", "chat"]);
    expect(args).toContain("--keep");
    expect(args).toContain("value");
    expect(args).not.toContain("other");
    expect(args).not.toContain("other-short");
    expect(args).not.toContain("other-skill");
    expect(args.slice(3).some((arg) => /^(?:--profile|-p|--skills|-s)(?:=|$)/.test(arg))).toBe(false);
  });

  it.each(["../outside", "profile/name", "profile;rm", "", " ", " profile ", { name: "profile" }])(
    "rejects unsafe profile %j before spawning Hermes",
    async (profile) => {
      const { ctx } = makeCtx({ profile });

      const result = await execute(ctx as any);

      expect(result).toMatchObject({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_local_profile_invalid",
      });
      if (String(profile).trim().length > 0) {
        expect(result.errorMessage).not.toContain(String(profile));
      }
      expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    },
  );

  it("injects exact managed SKILL.md bodies into a source-independent prompt bundle", async () => {
    hermesTestState.files.set("/paperclip/alpha/SKILL.md", "# Alpha\n\nUse alpha carefully.\n");
    hermesTestState.files.set("/paperclip/beta/SKILL.md", "# Beta\n\nUse beta carefully.\n");

    const { ctx } = makeCtx({
      paperclipRuntimeSkills: [
        { key: "alpha", runtimeName: "alpha", source: "/paperclip/alpha" },
        { key: "beta", runtimeName: "beta", source: "/paperclip/beta" },
        { key: "missing", runtimeName: "missing", source: "/paperclip/missing" },
      ],
      paperclipSkillSync: { desiredSkills: ["beta", "alpha", "missing"] },
    });

    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    const prompt = args[args.indexOf("-q") + 1]!;
    expect(prompt).toContain("### Paperclip managed skill: beta");
    expect(prompt).toContain("# Beta\n\nUse beta carefully.");
    expect(prompt).toContain("### Paperclip managed skill: alpha");
    expect(prompt).toContain("# Alpha\n\nUse alpha carefully.");
    expect(prompt.indexOf("managed skill: beta")).toBeLessThan(prompt.indexOf("managed skill: alpha"));
    expect(prompt).not.toContain("managed skill: missing");
    expect(prompt).not.toContain("/paperclip/beta");
    expect(prompt).not.toContain("/paperclip/alpha");
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});
