import { describe, expect, it, vi } from "vitest";
import {
  CODEX_DEVICE_LOGIN_COMMAND,
  runDeviceLogin,
  type SandboxLoginDriver,
} from "./device-login-runner.js";

const REAL_SHAPED_URL = "https://auth.openai.com/codex/device";
const REAL_SHAPED_CODE = "WXYZ-12345";
const TOKEN_SENTINEL = "SENTINEL_TOKEN_ABC123";
const AUTH_BYTES = Buffer.from(
  JSON.stringify({ tokens: { account_id: "acc", refresh_token: TOKEN_SENTINEL } }),
);

interface FakeDriverOptions {
  chunks?: string[];
  exitCode?: number;
  hang?: boolean;
  execError?: Error;
  readError?: Error;
  authBytes?: Buffer;
}

function createFakeDriver(options: FakeDriverOptions = {}) {
  const disposeCalls = { count: 0 };
  const driver: SandboxLoginDriver = {
    async start(_command, onData) {
      if (options.execError) throw options.execError;
      for (const chunk of options.chunks ?? []) {
        onData(chunk);
      }
      if (options.hang) {
        // Never resolve. The runner must fall back to its timeout or signal.
        await new Promise<never>(() => {});
      }
      return { exitCode: options.exitCode ?? 0 };
    },
    async readFile() {
      if (options.readError) throw options.readError;
      return options.authBytes ?? AUTH_BYTES;
    },
    async dispose() {
      disposeCalls.count += 1;
    },
  };
  return { driver, disposeCalls };
}

describe("runDeviceLogin", () => {
  it("runner_reports_prompt_then_success", async () => {
    const { driver, disposeCalls } = createFakeDriver({
      // The prompt spans two chunks; the runner must join them and fire once.
      // The chunk boundary falls inside the prompt, after the code preamble.
      chunks: [
        `1. Open this link\n${REAL_SHAPED_URL}\n2. Enter this one-time code (expires in 15 minutes)\n`,
        `${REAL_SHAPED_CODE}\nDone.\n`,
      ],
      exitCode: 0,
    });
    const onPrompt = vi.fn();
    const onCredential = vi.fn();
    const result = await runDeviceLogin(driver, {
      onPrompt,
      onCredential,
      authPath: "/home/.codex/auth.json",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.promptSurfaced).toBe(true);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: REAL_SHAPED_URL, code: REAL_SHAPED_CODE });
    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith(AUTH_BYTES);
    expect(disposeCalls.count).toBe(1);
  });

  it("runner_surfaces_prompt_after_a_large_pre_prompt_stream", async () => {
    // The sandbox streams a large volume of output before the prompt. The runner
    // bounds the parse buffer, so the memory stays limited. The prompt arrives at
    // the end of the stream, so the trailing window still holds it and the runner
    // surfaces it.
    const noise = "unrelated sandbox log line\n".repeat(20000);
    const { driver } = createFakeDriver({
      chunks: [
        noise,
        `1. Open this link\n${REAL_SHAPED_URL}\n2. Enter this one-time code (expires in 15 minutes)\n${REAL_SHAPED_CODE}\nDone.\n`,
      ],
      exitCode: 0,
    });
    const onPrompt = vi.fn();
    const result = await runDeviceLogin(driver, { onPrompt, timeoutMs: 1000 });
    expect(result.outcome).toBe("success");
    expect(result.promptSurfaced).toBe(true);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: REAL_SHAPED_URL, code: REAL_SHAPED_CODE });
  });

  it("runner_surfaces_prompt_at_the_start_of_one_large_chunk", async () => {
    // One stdout callback supplies more than the retained-buffer limit. The
    // prompt sits near the start, and a large volume of output follows it. The
    // runner parses the whole chunk before it trims the retained window, so it
    // still finds the early prompt and never drops it.
    const trailingNoise = "unrelated sandbox log line\n".repeat(20000);
    const { driver } = createFakeDriver({
      chunks: [
        `1. Open this link\n${REAL_SHAPED_URL}\n2. Enter this one-time code (expires in 15 minutes)\n${REAL_SHAPED_CODE}\nDone.\n${trailingNoise}`,
      ],
      exitCode: 0,
    });
    const onPrompt = vi.fn();
    const result = await runDeviceLogin(driver, { onPrompt, timeoutMs: 1000 });
    expect(result.outcome).toBe("success");
    expect(result.promptSurfaced).toBe(true);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: REAL_SHAPED_URL, code: REAL_SHAPED_CODE });
  });

  it("runner_disposes_sandbox_on_timeout", async () => {
    const { driver, disposeCalls } = createFakeDriver({ hang: true });
    const onPrompt = vi.fn();
    const result = await runDeviceLogin(driver, { onPrompt, timeoutMs: 20 });
    expect(result.outcome).toBe("timeout");
    expect(disposeCalls.count).toBe(1);
  });

  it("runner_disposes_sandbox_on_cancellation", async () => {
    const { driver, disposeCalls } = createFakeDriver({ hang: true });
    const controller = new AbortController();
    const onPrompt = vi.fn();
    const promise = runDeviceLogin(driver, {
      onPrompt,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
    expect(disposeCalls.count).toBe(1);
  });

  it("runner_reports_failure_on_nonzero_exit", async () => {
    const { driver, disposeCalls } = createFakeDriver({ exitCode: 7 });
    const onPrompt = vi.fn();
    const result = await runDeviceLogin(driver, { onPrompt, timeoutMs: 1000 });
    expect(result.outcome).toBe("failure");
    expect(result.exitCode).toBe(7);
    expect(disposeCalls.count).toBe(1);
  });

  it("runner_logs_and_result_contain_no_url_code_or_token_sentinel", async () => {
    const logs: string[] = [];
    const { driver } = createFakeDriver({
      chunks: [
        `${REAL_SHAPED_URL}\n${REAL_SHAPED_CODE}\n`,
        `refresh_token=${TOKEN_SENTINEL}\n`,
      ],
      exitCode: 0,
    });
    const result = await runDeviceLogin(driver, {
      onPrompt: () => {},
      timeoutMs: 1000,
      log: (line) => {
        logs.push(line);
      },
    });
    const haystack = `${logs.join("\n")}\n${JSON.stringify(result)}`;
    expect(haystack).not.toContain(REAL_SHAPED_URL);
    expect(haystack).not.toContain(REAL_SHAPED_CODE);
    expect(haystack).not.toContain(TOKEN_SENTINEL);
  });

  it("runner_error_messages_contain_no_url_or_code", async () => {
    const { driver, disposeCalls } = createFakeDriver({
      // A driver error whose message embeds secret-bearing text. The runner must
      // never let that message reach its own thrown error.
      execError: new Error(`network failure while streaming ${REAL_SHAPED_URL} ${REAL_SHAPED_CODE}`),
    });
    let caught: unknown;
    try {
      await runDeviceLogin(driver, { onPrompt: () => {}, timeoutMs: 1000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(REAL_SHAPED_URL);
    expect(message).not.toContain(REAL_SHAPED_CODE);
    // The driver is still disposed on the error path.
    expect(disposeCalls.count).toBe(1);
  });

  it("exposes the default login command", () => {
    expect(CODEX_DEVICE_LOGIN_COMMAND).toContain("codex");
    expect(CODEX_DEVICE_LOGIN_COMMAND).toContain("--device-auth");
  });
});
