import { describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_PROMPT } from "./setup-token-parse.js";
import {
  CLAUDE_SETUP_TOKEN_COMMAND,
  CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS,
  CODE_SUBMISSION_TERMINATOR,
  runSetupTokenLogin,
  type SetupTokenPtyDriver,
} from "./setup-token-runner.js";

// A well-formed authorization URL. The query keys match the contract exactly.
// The values are synthetic; no real value is present.
const VALID_URL =
  "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";

// The rendered login output. The preamble line, the URL line, and the dedicated
// prompt line match the Phase 2 parser contract.
const PROMPT_OUTPUT = [
  "Welcome to Claude Code",
  "Opening browser to sign in…",
  "Browser didn't open? Use the url below to sign in (c to copy)",
  VALID_URL,
  "Paste code here if prompted >",
  "",
].join("\n");

// A synthetic browser code. No test log, result, error, or metadata field may
// contain this value.
const BROWSER_CODE = "SENTINEL-CODE-9182";

// A synthetic OAuth token, wrapped across two physical lines the way the
// terminal wraps a real token. No real token is present.
const TOKEN_FRAGMENT_A = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEE1111";
const TOKEN_FRAGMENT_B = "2222FFFFGGGG_HHHH-IIII";
const FULL_TOKEN = `${TOKEN_FRAGMENT_A}${TOKEN_FRAGMENT_B}`;

// The rendered success screen. The anchor lines bracket the wrapped token, the
// same way the Phase 6a success record records them.
const SUCCESS_OUTPUT = [
  "✓ Long-lived authentication token created successfully!",
  "",
  "Your OAuth token (valid for 1 year):",
  "",
  TOKEN_FRAGMENT_A,
  TOKEN_FRAGMENT_B,
  "",
  "Store this token securely. You won't be able to see it again.",
  "",
].join("\n");

interface FakeDriverOptions {
  // The chunks the driver streams to the runner in order.
  chunks?: string[];
  // The exit code the driver returns at once. When absent, the driver waits for
  // the test to resolve the exit, or for the runner to time out or cancel.
  exitCode?: number;
  // An error the driver throws from start(), to model a stream failure.
  startError?: Error;
}

function createFakeDriver(options: FakeDriverOptions = {}) {
  const writes: string[] = [];
  const stops = { count: 0 };
  const disposes = { count: 0 };
  let resolveExit: (exit: { exitCode: number | null }) => void = () => {};
  const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  const driver: SetupTokenPtyDriver = {
    async start(_command, onData) {
      if (options.startError) throw options.startError;
      for (const chunk of options.chunks ?? []) {
        onData(chunk);
      }
      if (options.exitCode !== undefined) {
        return { exitCode: options.exitCode };
      }
      return exitPromise;
    },
    write(input) {
      writes.push(input);
    },
    stop() {
      stops.count += 1;
    },
    async dispose() {
      disposes.count += 1;
    },
  };
  return { driver, writes, stops, disposes, resolveExit: (code: number) => resolveExit({ exitCode: code }) };
}

// Lets the pending microtasks run, so the code-input routine writes to the PTY.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runSetupTokenLogin", () => {
  it("sends one login URL through onPrompt", async () => {
    // A success stream and a resolving sink, so the run reports success after the
    // runner delivers the credential.
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    const onPrompt = vi.fn();
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt,
      provideCode: async () => BROWSER_CODE,
      onCredential: async () => {},
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("success");
    expect(result.promptSurfaced).toBe(true);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: VALID_URL, prompt: SETUP_TOKEN_PROMPT });
  });

  it("accepts one browser code and sends it to the prompt", async () => {
    // The stream carries the prompt and the success record. The runner submits the
    // code, then it delivers the credential and reports success after the sink.
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT] });
    const onPrompt = vi.fn();
    const provideCode = vi.fn(async () => BROWSER_CODE);
    const promise = runSetupTokenLogin(fake.driver, {
      onPrompt,
      provideCode,
      onCredential: async () => {},
      timeoutMs: 1000,
      codeSubmitSettleMs: 0,
    });
    await flush();
    // The runner writes the code once, only after it matches the prompt. It writes
    // the code and the terminator as two separate writes, so the terminator reads
    // as a distinct Return key against an Ink paste field.
    expect(provideCode).toHaveBeenCalledTimes(1);
    expect(fake.writes).toEqual([BROWSER_CODE, CODE_SUBMISSION_TERMINATOR]);
    fake.resolveExit(0);
    const result = await promise;
    expect(result.outcome).toBe("success");
    expect(result.codeSubmitted).toBe(true);
  });

  it("never writes the code before it matches the prompt", async () => {
    // The driver streams noise with no prompt, then exits. The runner must never
    // send the code, because it never matched the prompt.
    const fake = createFakeDriver({ chunks: ["unrelated output\n"], exitCode: 0 });
    const provideCode = vi.fn(async () => BROWSER_CODE);
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode,
      timeoutMs: 1000,
    });
    expect(result.promptSurfaced).toBe(false);
    expect(result.codeSubmitted).toBe(false);
    expect(provideCode).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });

  it("stops the process on a timeout", async () => {
    const fake = createFakeDriver();
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 20,
    });
    expect(result.outcome).toBe("timeout");
    expect(fake.stops.count).toBe(1);
    expect(fake.disposes.count).toBe(1);
  });

  it("stops the process on a cancellation", async () => {
    const fake = createFakeDriver();
    const controller = new AbortController();
    const promise = runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
    expect(fake.stops.count).toBe(1);
    expect(fake.disposes.count).toBe(1);
  });

  it("stops the process on a nonzero exit", async () => {
    const fake = createFakeDriver({ exitCode: 7 });
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("failure");
    expect(result.exitCode).toBe(7);
    expect(fake.stops.count).toBe(1);
    expect(fake.disposes.count).toBe(1);
  });

  it("keeps the code out of every log, result, and error field", async () => {
    const logs: string[] = [];
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT], exitCode: 0 });
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 1000,
      log: (line) => {
        logs.push(line);
      },
    });
    const haystack = `${logs.join("\n")}\n${JSON.stringify(result)}`;
    expect(haystack).not.toContain(BROWSER_CODE);
    expect(haystack).not.toContain(VALID_URL);
  });

  it("keeps the code out of the thrown error on a stream failure", async () => {
    const fake = createFakeDriver({
      startError: new Error(`stream failure with ${VALID_URL} ${BROWSER_CODE}`),
    });
    let caught: unknown;
    try {
      await runSetupTokenLogin(fake.driver, {
        onPrompt: () => {},
        provideCode: async () => BROWSER_CODE,
        timeoutMs: 1000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(VALID_URL);
    expect(message).not.toContain(BROWSER_CODE);
    expect(fake.stops.count).toBe(1);
    expect(fake.disposes.count).toBe(1);
  });

  it("parses an early prompt inside one large chunk before truncation", async () => {
    // One chunk holds the prompt at its start and a large volume of output after
    // it. The chunk is larger than the retained-buffer limit. The runner parses
    // the whole chunk before it trims the retained window, so it still finds the
    // early prompt and never drops it.
    const trailingNoise = "unrelated output line\n".repeat(
      Math.ceil(CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS / 10),
    );
    const fake = createFakeDriver({ chunks: [`${PROMPT_OUTPUT}${trailingNoise}`], exitCode: 0 });
    const onPrompt = vi.fn();
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt,
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 1000,
    });
    expect(result.promptSurfaced).toBe(true);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: VALID_URL, prompt: SETUP_TOKEN_PROMPT });
  });

  it("fails when a clean exit has no token block, even with a sink present", async () => {
    // The stream holds only the prompt, so the token parser binds nothing. The
    // runner treats a clean exit with no bound token as a failure. It never calls
    // the sink and never reports success.
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT], exitCode: 0 });
    const onCredential = vi.fn(async () => {});
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      onCredential,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("failure");
    expect(onCredential).not.toHaveBeenCalled();
    expect(result.credentialDelivered).toBe(false);
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("credential");
  });

  it("delivers the de-wrapped token once through onCredential and zeros it after", async () => {
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    // The sink copies the token value, because the runner zeros the buffer after
    // the delivery. The test reads the copy for the value and the original for the
    // zeroing proof.
    let received: string | null = null;
    const onCredential = vi.fn(async (bytes: Buffer) => {
      received = bytes.toString("utf8");
    });
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      onCredential,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("success");
    expect(result.credentialDelivered).toBe(true);
    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(received).toBe(FULL_TOKEN);
    // The runner zeros the token bytes after a successful delivery.
    const bytes = onCredential.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps the token out of every log, result, and error field", async () => {
    const logs: string[] = [];
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      onCredential: async () => {},
      timeoutMs: 1000,
      log: (line) => {
        logs.push(line);
      },
    });
    const haystack = `${logs.join("\n")}\n${JSON.stringify(result)}`;
    expect(haystack).not.toContain(FULL_TOKEN);
    expect(haystack).not.toContain(TOKEN_FRAGMENT_A);
    expect(result.credentialDelivered).toBe(true);
  });

  it("fails closed when no onCredential sink is present, even on a success stream", async () => {
    // The sink is mandatory for a successful run. With no sink the runner never
    // scans for the token and treats the clean exit as a failure, even when the
    // success block is present.
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("failure");
    expect(result.credentialDelivered).toBe(false);
  });

  it("fails and zeros the token when the sink throws synchronously", async () => {
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    let seen: Buffer | null = null;
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      // A synchronous throw. The runner catches it, fails closed, and never
      // reports success.
      onCredential: (bytes) => {
        seen = bytes;
        throw new Error("synchronous sink failure");
      },
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("failure");
    expect(result.credentialDelivered).toBe(false);
    expect(seen).not.toBeNull();
    expect((seen as unknown as Buffer).every((byte) => byte === 0)).toBe(true);
  });

  it("fails and zeros the token when the sink rejects asynchronously", async () => {
    const fake = createFakeDriver({ chunks: [PROMPT_OUTPUT, SUCCESS_OUTPUT], exitCode: 0 });
    let seen: Buffer | null = null;
    const result = await runSetupTokenLogin(fake.driver, {
      onPrompt: () => {},
      provideCode: async () => BROWSER_CODE,
      // An asynchronous rejection. The runner does not swallow it: it maps the
      // rejection to a failure and never reports success.
      onCredential: async (bytes) => {
        seen = bytes;
        throw new Error("asynchronous sink failure");
      },
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("failure");
    expect(result.credentialDelivered).toBe(false);
    expect(seen).not.toBeNull();
    expect((seen as unknown as Buffer).every((byte) => byte === 0)).toBe(true);
  });

  it("exposes the fixed setup-token command", () => {
    expect(CLAUDE_SETUP_TOKEN_COMMAND).toBe("claude setup-token");
  });
});
