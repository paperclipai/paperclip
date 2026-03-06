import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "../adapters/utils.js";

const ORIGINAL_CLAUDECODE = process.env.CLAUDECODE;
const ORIGINAL_CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT;

afterEach(() => {
  if (ORIGINAL_CLAUDECODE === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = ORIGINAL_CLAUDECODE;

  if (ORIGINAL_CLAUDE_CODE_ENTRYPOINT === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = ORIGINAL_CLAUDE_CODE_ENTRYPOINT;
});

describe("runChildProcess env isolation", () => {
  it("strips CLAUDECODE nesting guard from child process environment", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

    const result = await runChildProcess(
      "test-nesting-strip",
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT}))"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv.CLAUDECODE).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("preserves PAPERCLIP_* env vars in child process", async () => {
    const result = await runChildProcess(
      "test-env-preserved",
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({url: process.env.PAPERCLIP_API_URL, id: process.env.PAPERCLIP_AGENT_ID}))"],
      {
        cwd: process.cwd(),
        env: {
          PAPERCLIP_API_URL: "http://localhost:3100",
          PAPERCLIP_AGENT_ID: "agent-123",
        },
        timeoutSec: 10,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv.url).toBe("http://localhost:3100");
    expect(childEnv.id).toBe("agent-123");
  });

  it("preserves PATH so child can resolve commands", async () => {
    const result = await runChildProcess(
      "test-path-preserved",
      process.execPath,
      ["-e", "process.stdout.write(process.env.PATH || \'\')"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
