import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.fn();
vi.mock("./bwrap-sandbox-check.js", () => ({
  verifyCodexBwrapSandbox: (...args: unknown[]) => verifyMock(...args),
}));
const resolveCodexCommandMock = vi.fn();
vi.mock("./codex-command.js", () => ({
  resolveCodexCommand: (...args: unknown[]) => resolveCodexCommandMock(...args),
}));

import { assertCodexBwrapSandboxReady, resolveLaunchedCodexExecutable } from "./bwrap-sandbox-gate.js";

const probeFailure = {
  ok: false,
  bwrapPath: "/fake/bwrap",
  reason: "bwrap probe failed (exit 1) at /fake/bwrap: bwrap: setting up uid map: Permission denied",
  probeStderr: "bwrap: setting up uid map: Permission denied",
};

describe("assertCodexBwrapSandboxReady", () => {
  let originalCheckDisabled: string | undefined;
  let originalOptOut: string | undefined;
  let originalVitest: string | undefined;

  beforeEach(() => {
    verifyMock.mockReset();
    resolveCodexCommandMock.mockReset();
    originalCheckDisabled = process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED;
    originalOptOut = process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT;
    delete process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED;
    delete process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT;
    // The gate skips vitest runs (process.env.VITEST === "true", set by the
    // test runner itself). These tests exercise the production path, so
    // clear it to simulate a non-vitest process.
    originalVitest = process.env.VITEST;
    delete process.env.VITEST;
  });

  afterEach(() => {
    if (originalCheckDisabled === undefined) delete process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED;
    else process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED = originalCheckDisabled;
    if (originalOptOut === undefined) delete process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT;
    else process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT = originalOptOut;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    vi.restoreAllMocks();
  });

  it("passes through when the probe reports a working sandbox", async () => {
    verifyMock.mockResolvedValue({ ok: true, bwrapPath: "/fake/bwrap", reason: null, probeStderr: null });
    await expect(assertCodexBwrapSandboxReady()).resolves.toBeUndefined();
    expect(verifyMock).toHaveBeenCalledWith({ anchorPath: undefined, signal: undefined });
  });

  it("refuses the session when the probe fails and no opt-out is set", async () => {
    verifyMock.mockResolvedValue(probeFailure);
    await expect(assertCodexBwrapSandboxReady()).rejects.toThrow(
      /Refusing to start Codex without an operational bwrap sandbox/,
    );
  });

  it("continues with a logged warning when PAPERCLIP_RUNNER_BWRAP_OPTOUT=1 (process env)", async () => {
    process.env.PAPERCLIP_RUNNER_BWRAP_OPTOUT = "1";
    verifyMock.mockResolvedValue(probeFailure);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(assertCodexBwrapSandboxReady()).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("PAPERCLIP_RUNNER_BWRAP_OPTOUT=1"),
    );
  });

  it("continues with a logged warning when the opt-out is scoped to the session environment", async () => {
    verifyMock.mockResolvedValue(probeFailure);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      assertCodexBwrapSandboxReady({
        environment: { PAPERCLIP_RUNNER_BWRAP_OPTOUT: "1" },
      }),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("PAPERCLIP_RUNNER_BWRAP_OPTOUT=1"),
    );
  });

  it("skips the probe entirely when PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED=1", async () => {
    process.env.PAPERCLIP_RUNNER_BWRAP_CHECK_DISABLED = "1";
    verifyMock.mockImplementation(() => {
      throw new Error("probe must not run when the check is disabled");
    });
    await expect(assertCodexBwrapSandboxReady()).resolves.toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("skips the probe in vitest runs even when the sandbox is broken", async () => {
    // "true" is the literal value vitest sets (not "1"); the describe-level
    // beforeEach cleared it, so set it here to exercise the skip branch.
    process.env.VITEST = "true";
    verifyMock.mockImplementation(() => {
      throw new Error("probe must not run in vitest workers");
    });
    await expect(assertCodexBwrapSandboxReady()).resolves.toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("passes the run signal through to the probe", async () => {
    verifyMock.mockResolvedValue({ ok: true, bwrapPath: "/fake/bwrap", reason: null, probeStderr: null });
    const controller = new AbortController();
    await assertCodexBwrapSandboxReady({ signal: controller.signal });
    expect(verifyMock).toHaveBeenCalledWith({ anchorPath: undefined, signal: controller.signal });
  });

  it("passes the launched command anchor through to the probe", async () => {
    verifyMock.mockResolvedValue({ ok: true, bwrapPath: "/fake/bwrap", reason: null, probeStderr: null });
    await assertCodexBwrapSandboxReady({ anchorPath: "/opt/codex/bin/codex" });
    expect(verifyMock).toHaveBeenCalledWith({ anchorPath: "/opt/codex/bin/codex", signal: undefined });
  });
});

describe("resolveLaunchedCodexExecutable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the resolved executable for the session environment and directory", () => {
    resolveCodexCommandMock.mockReturnValue("/opt/codex/bin/codex");
    expect(
      resolveLaunchedCodexExecutable({ PATH: "/usr/bin" }, "/work"),
    ).toBe("/opt/codex/bin/codex");
    expect(resolveCodexCommandMock).toHaveBeenCalledWith(undefined, { PATH: "/usr/bin" }, "/work");
  });

  it("returns null when no Codex installation resolves (the transport reports the launch failure)", () => {
    resolveCodexCommandMock.mockImplementation(() => {
      throw new Error("No installed Codex dependency or executable on PATH");
    });
    expect(resolveLaunchedCodexExecutable(undefined, "/work")).toBeNull();
  });
});
