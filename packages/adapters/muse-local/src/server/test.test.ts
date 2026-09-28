import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runProcessMock: vi.fn(), ensureCommandMock: vi.fn(async () => {}) }));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "remote box",
  ensureAdapterExecutionTargetCommandResolvable: (...a: unknown[]) => (mocks.ensureCommandMock as (...x: unknown[]) => unknown)(...a),
  ensureAdapterExecutionTargetDirectory: async () => {},
  resolveAdapterExecutionTargetCwd: (_t: unknown, cwd: string, fallback: string) => cwd || fallback,
  runAdapterExecutionTargetProcess: (...a: unknown[]) => (mocks.runProcessMock as (...x: unknown[]) => unknown)(...a),
}));

import os from "node:os";
import { afterEach } from "vitest";
import { testEnvironment } from "./test.js";
import { promoteMuseDeviceLoginCredential } from "./muse-home.js";

const fixture = (name: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

function helloStdout(text: string) {
  return JSON.stringify({ schema_version: 1, stream: { kind: "session", id: "s" }, sequence: 1, record_type: "event", payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text, reason: null } });
}

describe("muse_local testEnvironment", () => {
  beforeEach(() => {
    mocks.runProcessMock.mockReset();
    mocks.ensureCommandMock.mockReset();
    mocks.ensureCommandMock.mockResolvedValue(undefined);
  });

  it("passes when the hello probe answers", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: helloStdout("hello"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("pass");
    expect(result.checks.map((c) => c.code)).toContain("muse_hello_probe_passed");
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args).toEqual(expect.arrayContaining(["exec", "--json", "--no-session-log", "--approval-mode", "never"]));
    const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
    expect(env.TBH_CREDENTIAL_BACKEND).toBeUndefined();
  });

  it("probes with the company Muse key from a sandbox device login when nothing else is bound", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-envtest-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("META_API_KEY", "");
    try {
      const key = "LLM|888888888888888|envtestcompanykey00000000";
      await promoteMuseDeviceLoginCredential({ authBytes: Buffer.from(JSON.stringify({ providers: { meta: { api_key: key } } })), companyId: "c", userInitiated: true, isSoleActiveOwner: () => true, log: () => {} });
      mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: helloStdout("hello"), stderr: "" });
      await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
      const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
      expect(env.META_API_KEY).toBe(key);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("warns with auth_required when the key is rejected", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: await fixture("exec-badkey.jsonl"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    const check = result.checks.find((c) => c.code === "muse_hello_probe_auth_required");
    expect(check?.level).toBe("warn");
    expect(check?.hint).toMatch(/muse login/);
    expect(result.status).toBe("warn");
  });

  it("errors when the command is missing and skips the probe", async () => {
    mocks.ensureCommandMock.mockRejectedValue(new Error("Command not found: muse"));
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toContain("muse_command_unresolvable");
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
  });

  it("probes remote targets through the execution target", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: helloStdout("hello"), stderr: "" });
    const target = { kind: "remote", transport: "ssh" };
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" }, executionTarget: target } as never);
    expect(mocks.runProcessMock.mock.calls[0]![1]).toBe(target);
    expect(result.status).toBe("pass");
  });
});
