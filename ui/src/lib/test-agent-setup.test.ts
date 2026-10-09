import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testAgentSetup } from "./test-agent-setup";
import { adaptersApi } from "../api/adapters";
import { api } from "../api/client";
import { queryKeys } from "./queryKeys";
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
afterEach(() => vi.restoreAllMocks());
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
      runner: "legacy",
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
    agentId: "agent-1", environmentId: "sandbox-1", runner: "legacy",
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

it("keeps the resolved native identity and explicitly bounds the supplementary Codex CLI probe to legacy", async () => {
  testEnvironment.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, adapterType: "codex_local" });
  const result = await testAgentSetup({ ...input, adapterType: "codex_local", providerAdapter: "codex_local", runner: "paperclip" });
  expect(result.adapterType).toBe("paperclip_runner");
  expect(testEnvironment.mock.calls[0][2].runner).toBe("paperclip");
  expect(testEnvironment.mock.calls[1][2].runner).toBe("legacy");
});

describe("adapter availability discovery", () => {
  it("keeps inventory unscoped and sends the selected company and target", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue([]);
    await adaptersApi.list();
    await adaptersApi.list({ companyId: "company-1", environmentId: "linux ssh" });
    await adaptersApi.list({ companyId: "company-2", environmentId: null });
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/adapters", "/adapters?companyId=company-1&environmentId=linux+ssh", "/adapters?companyId=company-2",
    ]);
  });
  it("isolates target availability from inventory, other targets, and other companies", () => {
    const selected = queryKeys.adapters.availability("company-1", "linux");
    expect(selected).not.toEqual(queryKeys.adapters.all);
    expect(selected).not.toEqual(queryKeys.adapters.availability("company-1", "mac"));
    expect(selected).not.toEqual(queryKeys.adapters.availability("company-2", "linux"));
  });
});
