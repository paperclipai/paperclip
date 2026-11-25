import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Done.\n",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import { getConfigSchema } from "./config-schema.js";

function makeCtx(config: Record<string, unknown> = {}) {
  return {
    runId: "test-run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, model: "glm-4.6:cloud", ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes-local adapter billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports no billing type when none is configured", async () => {
    const result = await execute(makeCtx() as never);
    expect(result.billingType).toBeUndefined();
    expect(result.biller).toBeUndefined();
  });

  it("reports the configured billing type and biller", async () => {
    const result = await execute(makeCtx({ billingType: "subscription_included", biller: " ollama " }) as never);
    expect(result).toMatchObject({ billingType: "subscription_included", biller: "ollama" });
  });

  it("reports a configured billing type without a biller", async () => {
    const result = await execute(makeCtx({ billingType: "metered_api" }) as never);
    expect(result.billingType).toBe("metered_api");
    expect(result.biller).toBeUndefined();
  });

  it.each(["", "unknown", "free", 42])("ignores an unsupported billing type %j and its biller", async (billingType) => {
    const result = await execute(makeCtx({ billingType, biller: "ollama" }) as never);
    expect(result.billingType).toBeUndefined();
    expect(result.biller).toBeUndefined();
  });

  it("offers each supported billing type in the config schema", () => {
    const field = getConfigSchema().fields.find((candidate) => candidate.key === "billingType");
    expect(field?.type).toBe("select");
    expect(field?.options?.map((option) => option.value).sort()).toEqual([
      "", "api", "credits", "fixed", "metered_api", "subscription", "subscription_included", "subscription_overage",
    ]);
  });
});
