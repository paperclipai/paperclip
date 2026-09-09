import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

const ORIGINAL_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;

// The server-level value an operator got wrong: an auth proxy that answers HTML
// rather than the board API.
const BROKEN_SERVER_API_URL = "https://board.example.com";
const AGENT_SUPPLIED_API_URL = "http://attacker.example.invalid";

const AGENT = {
  id: "agent-1",
  companyId: "company-1",
  name: "Conductor",
  adapterType: "process",
  adapterConfig: null,
};

function contextFor(
  config: Record<string, unknown>,
  options: { authToken?: string } = {},
): { ctx: AdapterExecutionContext; stdout: () => string } {
  let stdout = "";
  const ctx: AdapterExecutionContext = {
    runId: "11111111-2222-3333-4444-555555555555",
    agent: AGENT,
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
    },
    authToken: options.authToken,
  };
  return { ctx, stdout: () => stdout };
}

/** A child that prints the Paperclip env it actually received. */
function echoEnvCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({"
        + "apiUrl: process.env.PAPERCLIP_API_URL ?? null,"
        + "apiKey: process.env.PAPERCLIP_API_KEY ?? null,"
        + "agentId: process.env.PAPERCLIP_AGENT_ID ?? null"
        + "}))",
    ],
  };
}

beforeEach(() => {
  process.env.PAPERCLIP_API_URL = BROKEN_SERVER_API_URL;
  delete process.env.PAPERCLIP_RUNTIME_API_URL;
});

afterEach(() => {
  if (ORIGINAL_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_API_URL;

  if (ORIGINAL_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
  else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_RUNTIME_API_URL;
});

describe("process adapter runtime env", () => {
  it("hands the server-level PAPERCLIP_API_URL to the child by default", async () => {
    const { ctx, stdout } = contextFor({ ...echoEnvCommand() });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ apiUrl: BROKEN_SERVER_API_URL, agentId: "agent-1" });
  });

  it("refuses a PAPERCLIP_API_URL from adapterConfig.env", async () => {
    // An agent-authenticated caller can PATCH its own adapterConfig, so a
    // config-supplied API URL would let an agent point its harness-minted run
    // token at an origin of its choosing. The recovery path for a wrong runtime
    // URL is the startup probe, not this key.
    const { ctx, stdout } = contextFor({
      ...echoEnvCommand(),
      env: { PAPERCLIP_API_URL: AGENT_SUPPLIED_API_URL },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout()).apiUrl).toBe(BROKEN_SERVER_API_URL);
  });

  it("still refuses a PAPERCLIP_API_KEY from adapterConfig.env", async () => {
    const { ctx, stdout } = contextFor(
      { ...echoEnvCommand(), env: { PAPERCLIP_API_KEY: "config-supplied-key" } },
      { authToken: "harness-minted-token" },
    );

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    // The harness-minted run token is the only source of API identity.
    expect(JSON.parse(stdout()).apiKey).toBe("harness-minted-token");
  });

  it("still refuses to let adapterConfig.env rewrite a non-overridable runtime key", async () => {
    const { ctx, stdout } = contextFor({
      ...echoEnvCommand(),
      env: { PAPERCLIP_AGENT_ID: "impersonated-agent" },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout()).agentId).toBe("agent-1");
  });
});

describe("process adapter failure reporting", () => {
  it("names the cause in errorMessage rather than only the exit code", async () => {
    const { ctx } = contextFor({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('board call failed: expected JSON, got text/html\\n'); process.exit(1)",
      ],
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe(
      "Process exited with code 1: board call failed: expected JSON, got text/html",
    );
  });

  it("keeps the bare summary when the child exits silently", async () => {
    const { ctx } = contextFor({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
    });

    const result = await execute(ctx);

    expect(result.errorMessage).toBe("Process exited with code 2");
  });
});
