import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { execute } from "@paperclipai/adapter-hermes-gateway/server";
import { getServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function buildContext(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    onLog: async () => {},
    authToken: "jwt-test-token",
  };
}

describe("hermes_gateway registration", () => {
  it("registers hermes_gateway in the server adapter registry", () => {
    const adapter = getServerAdapter("hermes_gateway");

    expect(adapter.type).toBe("hermes_gateway");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
  });
});

describe("hermes_gateway execute", () => {
  it("fails cleanly when url is missing", async () => {
    const result = await execute(buildContext({}));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_url_missing");
  });

  it("streams logs and returns final summary from the gateway", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seenWakePayloads: Array<Record<string, unknown>> = [];

    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type !== "wake.run") return;
        seenWakePayloads.push(msg);
        const requestId = String(msg.requestId);
        socket.send(
          JSON.stringify({
            type: "ack",
            requestId,
            accepted: true,
            session: { id: "paperclip:agent:agent-123", resumed: false },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event.log",
            requestId,
            stream: "stdout",
            text: "hello from hermes gateway\n",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "final",
            requestId,
            ok: true,
            summary: "Hermes gateway completed the run.",
            session: { id: "paperclip:agent:agent-123", resumed: false },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve test server address");
    }

    const logs: string[] = [];
    try {
      const result = await execute({
        ...buildContext({ url: `ws://127.0.0.1:${address.port}` }),
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("Hermes gateway completed the run.");
      expect(result.sessionDisplayId).toBe("paperclip:agent:agent-123");
      expect(logs.join("")).toContain("hello from hermes gateway");
      expect(seenWakePayloads).toHaveLength(1);
      expect((seenWakePayloads[0].prompt as Record<string, unknown>).user).toContain("paperclip");
      expect((seenWakePayloads[0].prompt as Record<string, unknown>).user).toContain("get_issue");
      expect((seenWakePayloads[0].prompt as Record<string, unknown>).user).toContain("status update");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("propagates actionHint and followupIssue context into the wake payload", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seenWakePayloads: Array<Record<string, unknown>> = [];

    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type !== "wake.run") return;
        seenWakePayloads.push(msg);
        const requestId = String(msg.requestId);
        socket.send(
          JSON.stringify({
            type: "final",
            requestId,
            ok: true,
            summary: "ok",
            session: { id: "paperclip:agent:agent-123", resumed: false },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      await execute({
        ...buildContext({ url: `ws://127.0.0.1:${address.port}` }),
        context: {
          taskId: "task-123",
          issueId: "issue-123",
          wakeReason: "follow-up",
          issueIds: ["issue-123"],
          actionHint: "create_followup_issue",
          followupIssue: { title: "Hermes Gateway Follow-up Smoke", description: "create it" },
        },
      });

      expect(seenWakePayloads).toHaveLength(1);
      expect((seenWakePayloads[0].context as Record<string, unknown>).actionHint).toBe("create_followup_issue");
      expect((seenWakePayloads[0].context as Record<string, unknown>).followupIssue).toEqual({
        title: "Hermes Gateway Follow-up Smoke",
        description: "create it",
      });
      expect((seenWakePayloads[0].prompt as Record<string, unknown>).user).toContain("create_issue");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
