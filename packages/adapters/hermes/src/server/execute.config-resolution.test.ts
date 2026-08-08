/**
 * Integration tests for execute() configuration plumbing:
 *
 *   1. The Hermes profile selected by config.env.HERMES_HOME is the one
 *      detectModel() reads at execution time (parity with preflight).
 *   2. Instruction bundles keep a resolvable base directory in the prompt so
 *      relative resource references load while Hermes runs from the workspace.
 *   3. Placeholder session tokens are never persisted as resumable metadata.
 *
 * runChildProcess is mocked so no real Hermes process is spawned.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@paperclipai/adapter-utils/server-utils")
    >();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: "normal response\n\nsession_id: session-1\n",
      stderr: "",
    })),
  };
});

vi.mock("./detect-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect-model.js")>();
  return {
    ...actual,
    detectModel: vi.fn(async () => null),
  };
});

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { detectModel } from "./detect-model.js";
import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown> = {}) {
  return {
    runId: "test-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionParams: null },
    config: { command: "/usr/bin/hermes", cwd: "/tmp", ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as any;
}

function spawnedPrompt(): string {
  // args = ["chat", "-q", prompt, ...]
  const args = vi.mocked(runChildProcess).mock.calls.at(-1)?.[2] ?? [];
  return args[2] ?? "";
}

function mockHermesOutput(stdout: string, stderr = "") {
  vi.mocked(runChildProcess).mockResolvedValue({
    exitCode: 0,
    signal: null,
    timedOut: false,
    pid: 123,
    startedAt: "2026-07-15T00:00:00.000Z",
    stdout,
    stderr,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHermesOutput("normal response\n\nsession_id: session-1\n");
  vi.mocked(detectModel).mockResolvedValue(null);
});

describe("Hermes profile resolution (preflight/execution parity)", () => {
  it("reads the profile selected by config.env.HERMES_HOME", async () => {
    await execute(
      makeCtx({ model: "gpt-5.4", env: { HERMES_HOME: "/custom/hermes-profile" } }),
    );
    expect(detectModel).toHaveBeenCalledWith(
      join("/custom/hermes-profile", "config.yaml"),
    );
  });

  it("supports resolved-secret refs for HERMES_HOME", async () => {
    await execute(
      makeCtx({ model: "gpt-5.4", env: { HERMES_HOME: { value: "/secret/profile" } } }),
    );
    expect(detectModel).toHaveBeenCalledWith(
      join("/secret/profile", "config.yaml"),
    );
  });

  it("falls back to the default ~/.hermes profile", async () => {
    await execute(makeCtx({ model: "gpt-5.4" }));
    expect(detectModel).toHaveBeenCalledWith(
      join(process.env.HOME || process.env.USERPROFILE || "/root", ".hermes", "config.yaml"),
    );
  });

  it("skips detection when an explicit provider is configured", async () => {
    await execute(makeCtx({ model: "gpt-5.4", provider: "openrouter" }));
    expect(detectModel).not.toHaveBeenCalled();
  });
});

describe("instruction bundle base path", () => {
  it("names the bundle directory in the prompt so relative references resolve", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "hermes-instructions-"));
    const instructionsFilePath = join(bundleDir, "instructions.md");
    await writeFile(
      instructionsFilePath,
      "Read ./resources/style-guide.md before answering.",
      "utf-8",
    );

    await execute(makeCtx({ instructionsFilePath }));

    const prompt = spawnedPrompt();
    expect(prompt).toContain("Read ./resources/style-guide.md before answering.");
    expect(prompt).toContain(
      `instruction bundle directory: ${dirname(resolve(instructionsFilePath))}`,
    );
  });
});

describe("resumable session metadata validation", () => {
  it("persists an id-shaped session token", async () => {
    mockHermesOutput("All done.\n\nsession_id: abc123\n");
    const result = await execute(makeCtx());
    expect(result.sessionParams).toEqual({ sessionId: "abc123" });
    expect(result.sessionDisplayId).toBe("abc123");
    expect(result.resultJson?.session_id).toBe("abc123");
  });

  it("does not persist a placeholder token as resumable session metadata", async () => {
    mockHermesOutput("I could not resume the previous run.\n\nsession_id: unavailable\n");
    const result = await execute(makeCtx());
    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.resultJson?.session_id).toBeNull();
    expect(result.resultJson?.result).toContain("I could not resume the previous run.");
  });

  it("does not persist prose after session_id as metadata", async () => {
    mockHermesOutput("session_id: this is response text\n");
    const result = await execute(makeCtx());
    expect(result.sessionParams).toBeUndefined();
    expect(result.resultJson?.session_id).toBeNull();
    expect(result.resultJson?.result).toContain("session_id: this is response text");
  });
});
