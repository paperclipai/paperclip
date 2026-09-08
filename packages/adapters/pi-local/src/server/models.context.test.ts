import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: [
      "provider     model        context  max-out  thinking  images",
      "opencode-go  glm-5.2      200K     32K      yes       no",
    ].join("\n"),
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

import { listPiModels, resetPiModelsCacheForTests } from "./models.js";

describe("pi model discovery context", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetPiModelsCacheForTests();
  });

  it("forwards the caller-supplied env to `pi --list-models`", async () => {
    const models = await listPiModels({ env: { OPENCODE_API_KEY: "sk-from-company-secret" } });

    expect(models).toEqual([{ id: "opencode-go/glm-5.2", label: "opencode-go/glm-5.2" }]);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(call?.[2]).toContain("--list-models");
    // Without the context plumbing this key never reaches discovery, so a
    // provider whose credential lives in a company secret stays invisible.
    expect(call?.[3].env.OPENCODE_API_KEY).toBe("sk-from-company-secret");
  });

  it("still works with no context, falling back to the process env", async () => {
    await listPiModels();

    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(call?.[3].env.OPENCODE_API_KEY).toBeUndefined();
  });
});
