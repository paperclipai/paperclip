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

  it("declares support for local agent JWTs so heartbeat can mint run-scoped auth", () => {
    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
  });
});
