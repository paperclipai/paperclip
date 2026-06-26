import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { processAdapter } from "./index.js";

const baseContext = {
  agent: {
    id: "agent-1",
    companyId: "company-1",
    name: "Process Agent",
    adapterType: "process",
    adapterConfig: {},
  },
  runtime: {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  },
  context: {},
  onLog: async () => {},
};

describe("process adapter execute", () => {
  it("does not inject Paperclip run auth by default", async () => {
    const result = await execute({
      ...baseContext,
      runId: "run-default",
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ apiKey: process.env.PAPERCLIP_API_KEY || null, runId: process.env.PAPERCLIP_RUN_ID || null }))",
        ],
      },
      authToken: "token-default",
    });

    const stdout = String(result.resultJson?.stdout ?? "").trim();
    expect(JSON.parse(stdout)).toEqual({ apiKey: null, runId: null });
  });

  it("injects Paperclip API key and run id when run auth is explicitly enabled", async () => {
    const result = await execute({
      ...baseContext,
      runId: "run-opt-in",
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ apiKey: process.env.PAPERCLIP_API_KEY || null, runId: process.env.PAPERCLIP_RUN_ID || null }))",
        ],
        injectPaperclipRunAuth: true,
      },
      authToken: "token-opt-in",
    });

    const stdout = String(result.resultJson?.stdout ?? "").trim();
    expect(JSON.parse(stdout)).toEqual({ apiKey: "token-opt-in", runId: "run-opt-in" });
  });

  it("logs a diagnostic when run auth is enabled but no auth token is available", async () => {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const result = await execute({
      ...baseContext,
      runId: "run-opt-in-missing-token",
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ apiKey: process.env.PAPERCLIP_API_KEY || null, runId: process.env.PAPERCLIP_RUN_ID || null }))",
        ],
        injectPaperclipRunAuth: true,
      },
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    const stdout = String(result.resultJson?.stdout ?? "").trim();
    expect(JSON.parse(stdout)).toEqual({ apiKey: null, runId: null });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stderr",
        chunk: expect.stringContaining("no run-scoped auth token was available"),
      }),
    );
  });

  it("declares support for local agent JWTs so heartbeat can mint run-scoped auth", () => {
    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
  });
});
