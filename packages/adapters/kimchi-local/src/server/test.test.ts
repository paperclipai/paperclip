import { describe, expect, it, vi } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const readTargetMock = vi.hoisted(() => vi.fn(() => ({ kind: "local" })));
const runProcessMock = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "kimchi 0.1.0\n", stderr: "" })),
);

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureDirectoryMock,
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  readAdapterExecutionTarget: readTargetMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { testEnvironment } from "./test.js";

describe("kimchi_local testEnvironment", () => {
  it("reports a healthy local host with the ACP command and credentials detected", async () => {
    // The ACP availability check resolves `kimchi` on PATH; resolve a
    // well-known existing binary instead so the check passes on any host.
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "kimchi_local",
      config: {
        command: "node",
        cwd: "/tmp",
        env: { KIMCHI_API_KEY: "test-key" },
      },
    } as never);

    expect(result.status).toBe("pass");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "kimchi_engine_selected",
        "kimchi_acp_node_supported",
        "kimchi_acp_command_resolvable",
        "kimchi_acp_credentials_detected",
        "kimchi_acp_runtime_scaffold",
      ]),
    );
  });

  it("downgrades missing credentials to a warning", async () => {
    const previous = process.env.KIMCHI_API_KEY;
    delete process.env.KIMCHI_API_KEY;
    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "kimchi_local",
        config: { command: "node", cwd: "/tmp" },
      } as never);

      expect(result.status).toBe("warn");
      expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
        expect.arrayContaining(["kimchi_acp_credentials_not_detected"]),
      );
    } finally {
      if (previous !== undefined) process.env.KIMCHI_API_KEY = previous;
    }
  });
});
