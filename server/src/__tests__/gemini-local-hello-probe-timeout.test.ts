import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedTimeoutSec: number | null = null;

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );

  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(async () => {}),
    ensureCommandResolvable: vi.fn(async () => {}),
    ensurePathInEnv: vi.fn((env: Record<string, string>) => env),
    runChildProcess: vi.fn(async (_id, _command, _args, options: { timeoutSec: number }) => {
      capturedTimeoutSec = options.timeoutSec;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${JSON.stringify({ type: "result", subtype: "success", result: "hello" })}\n`,
        stderr: "",
      };
    }),
  };
});

describe("gemini_local hello probe timeout", () => {
  beforeEach(() => {
    capturedTimeoutSec = null;
  });

  it("uses 30 seconds as the default hello probe timeout", async () => {
    const { testEnvironment } = await import("@paperclipai/adapter-gemini-local/server");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        command: "gemini",
        cwd: process.cwd(),
        env: {
          GEMINI_API_KEY: "test-key",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(capturedTimeoutSec).toBe(30);
  });
});
