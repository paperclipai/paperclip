import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    ensureCommandResolvable: vi.fn().mockResolvedValue(undefined),
    runChildProcess: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "1.0.0",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    }),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { testEnvironment } from "./test.js";

describe("bob-shell testEnvironment env", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  it("does not hand server-only PAPERCLIP_* secrets to the probe", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "server-only-jwt-secret";

    await testEnvironment({
      companyId: "company-1",
      adapterType: "bob_shell",
      config: { env: { CUSTOM_FLAG: "1" } },
    });

    const resolvableEnv = vi.mocked(serverUtils.ensureCommandResolvable).mock.calls[0][2] as Record<string, string>;
    const probeEnv = (vi.mocked(serverUtils.runChildProcess).mock.calls[0][3] as { env: Record<string, string> }).env;
    for (const env of [resolvableEnv, probeEnv]) {
      expect(env).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
      expect(env.CUSTOM_FLAG).toBe("1");
    }
  });
});
