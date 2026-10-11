import { beforeEach, expect, it, vi } from "vitest";
import { describeSetupFailure, testAgentSetup } from "./test-agent-setup";
const testEnvironment = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { testEnvironment } }));
const input = {
  companyId: "company-1",
  agentId: "agent-1",
  adapterType: "paperclip_runner",
  providerAdapter: "claude_local",
  environmentId: "sandbox-1",
  adapterConfig: {
    provider: "acpx",
    acpxAgent: "claude",
    env: {
      ANTHROPIC_API_KEY: {
        type: "user_secret_ref",
        key: "ANTHROPIC_API_KEY",
        version: "latest",
      },
    },
  },
};
const ready = {
  adapterType: "paperclip_runner",
  status: "pass",
  testedAt: "now",
  checks: [{ code: "runtime", level: "info", message: "Ready" }],
};
beforeEach(() => testEnvironment.mockReset());
it("does not launch an ambient provider hello test for a pool preview", async () => {
  testEnvironment.mockResolvedValue({ ...ready, status: "warn", checks: [{ code: "ai_connection_pool_task_test_required", level: "warn", message: "Run a task" }] });
  await testAgentSetup({ ...input, aiConnection: { mode: "router", connectionId: "pool-id" } });
  expect(testEnvironment).toHaveBeenCalledTimes(1);
  expect(testEnvironment.mock.calls[0]?.[2].aiConnection).toEqual({ mode: "router", connectionId: "pool-id" });
});
it("does not report a connection when runtime readiness passes but provider authentication fails", async () => {
  testEnvironment
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({
      ...ready,
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Invalid API key",
        },
      ],
    });
  const result = await testAgentSetup(input);
  expect(result.status).toBe("fail");
  expect(result.adapterType).toBe("paperclip_runner");
  expect(testEnvironment).toHaveBeenLastCalledWith(
    "company-1",
    "claude_local",
    {
      agentId: "agent-1",
      environmentId: "sandbox-1",
      adapterConfig: { ...input.adapterConfig, engine: "cli" },
    },
  );
  expect(result.checks.map((check) => check.code)).toEqual([
    "runtime",
    "claude_hello_probe_failed",
  ]);
});
it("probes native Grok credentials with the pinned prerequisite in the selected sandbox", async () => {
  testEnvironment.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready,
    checks: [{ code: "grok_hello_probe_passed", level: "info", message: "Hello" }],
  });
  const result = await testAgentSetup({ ...input, providerAdapter: "grok_local",
    adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" },
  });
  expect(testEnvironment).toHaveBeenLastCalledWith("company-1", "grok_local", {
    agentId: "agent-1", environmentId: "sandbox-1",
    adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-4.7", engine: "cli", command: "/opt/paperclip/providers/grok/1.0.13/grok" },
  });
  expect(result.checks.some((check) => check.code === "grok_hello_probe_passed")).toBe(true);
});
it("does not repeat a completed model probe", async () => {
  testEnvironment.mockResolvedValue({
    ...ready,
    checks: [
      { code: "codex_hello_probe_passed", level: "info", message: "Hello" },
    ],
  });
  await testAgentSetup({
    ...input,
    adapterType: "codex_local",
    providerAdapter: "codex_local",
  });
  expect(testEnvironment).toHaveBeenCalledTimes(1);
});
it("preserves runtime warnings after a successful provider request", async () => {
  testEnvironment
    .mockResolvedValueOnce({ ...ready, status: "warn" })
    .mockResolvedValueOnce(ready);
  expect((await testAgentSetup(input)).status).toBe("warn");
});
it("adds the provider's JSON error message to a failed probe", () => {
  expect(
    describeSetupFailure([
      { code: "runtime", level: "info", message: "Ready" },
      {
        code: "codex_hello_probe_failed",
        level: "error",
        message: "Codex hello probe failed.",
        detail:
          '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Upgrade Codex to use this model."}}',
      },
    ]),
  ).toBe("Codex hello probe failed. Upgrade Codex to use this model.");
});
it("uses plain-text detail and falls back to the message without one", () => {
  expect(
    describeSetupFailure([
      {
        code: "claude_hello_probe_auth_required",
        level: "warn",
        message: "Claude is not signed in.",
        detail: "Run claude auth login.",
      },
    ]),
  ).toBe("Claude is not signed in. Run claude auth login.");
  expect(
    describeSetupFailure([
      { code: "codex_hello_probe_failed", level: "error", message: "Failed." },
    ]),
  ).toBe("Failed.");
  expect(describeSetupFailure([])).toBeUndefined();
});
it("truncates long details", () => {
  const message = describeSetupFailure([
    { code: "x_hello_probe_failed", level: "error", message: "Failed.", detail: "a".repeat(500) },
  ]);
  expect(message).toBe(`Failed. ${"a".repeat(300)}…`);
});
it("redacts credential material in probe details", () => {
  const message = describeSetupFailure([
    {
      code: "codex_hello_probe_failed",
      level: "error",
      message: "Failed.",
      detail: "request failed: Authorization: Bearer sk-fixture-secret-value-1234567890",
    },
  ]);
  expect(message).not.toContain("sk-fixture-secret-value-1234567890");
});
