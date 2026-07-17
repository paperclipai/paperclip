import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { getConfigSchema } from "./config-schema.js";
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

function spawnedArgs(): string[] {
  return vi.mocked(runChildProcess).mock.calls.at(-1)?.[2] ?? [];
}

function spawnedOptions() {
  return vi.mocked(runChildProcess).mock.calls.at(-1)?.[3];
}

const PROVIDER_EXHAUSTION_OUTPUT = `
API call failed (attempt 1/3): provider request failed
Model 'auto' is not supported by the OpenAI Codex provider
Fallback provider openrouter failed: HTTP 401 Unauthorized
non-retryable client error; no providers remain
All fallback providers failed
Resume this session with: hermes chat --resume deadbeef
`;

const PROVIDER_EXHAUSTION_ERROR =
  "Provider fallback exhaustion prevented Hermes from completing the request.";

describe("hermes-local compatibility invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: "normal response\n\nsession_id: session-1\n",
      stderr: "",
    });
  });

  it("keeps quiet schema and execution defaults aligned", async () => {
    const quietField = getConfigSchema().fields.find(
      (field) => field.key === "quiet",
    );
    expect(quietField?.default).toBe(true);

    await execute(makeCtx());
    expect(spawnedArgs()).toContain("-Q");
  });

  it("preserves the explicit quiet:false escape hatch", async () => {
    await execute(makeCtx({ quiet: false }));
    expect(spawnedArgs()).not.toContain("-Q");
  });

  it.each([{}, { model: "auto", provider: "auto" }])(
    "omits auto model and provider flags so Hermes can use its profile (%o)",
    async (config) => {
      const result = await execute(makeCtx(config));
      expect(spawnedArgs()).not.toContain("auto");
      expect(spawnedArgs()).not.toContain("-m");
      expect(spawnedArgs()).not.toContain("--provider");
      expect(result.model).toBe("auto");
      expect(result.provider).toBe("auto");
    },
  );

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const ctx = makeCtx();
    await execute(ctx);
    expect(spawnedOptions()?.onSpawn).toBe(ctx.onSpawn);
  });
});

describe("legacy provider-exhaustion false-green defense", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies the full terminal provider-exhaustion envelope as failure despite exit 0", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: PROVIDER_EXHAUSTION_OUTPUT,
      stderr: "",
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe(PROVIDER_EXHAUSTION_ERROR);
  });

  it("keeps ordinary HTTP-error prose successful", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout:
        "The API docs explain that HTTP 400 means a malformed request.\n\nsession_id: normal-1\n",
      stderr: "",
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
  });
});
