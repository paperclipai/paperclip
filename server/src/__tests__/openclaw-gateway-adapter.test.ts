import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { execute, testEnvironment } from "@paperclipai/adapter-openclaw-gateway/server";
import {
  buildOpenClawGatewayConfig,
  parseOpenClawGatewayStdoutLine,
} from "@paperclipai/adapter-openclaw-gateway/ui";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "OpenClaw Gateway Agent",
      adapterType: "openclaw_gateway",
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
    ...overrides,
  };
}

async function createMockGatewayServer(options?: {
  waitPayload?: Record<string, unknown>;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayload = frame.params ?? null;
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : "run-123";

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );

        socket.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "cha" },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              seq: 2,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "chacha" },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: options?.waitPayload ?? {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayload: () => agentPayload,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createMockGatewayServerWithPairing() {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;
  let approved = false;
  let pendingRequestId = "req-1";
  let lastSeenDeviceId: string | null = null;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        const device = frame.params?.device as Record<string, unknown> | undefined;
        const deviceId = typeof device?.id === "string" ? device.id : null;
        if (deviceId) {
          lastSeenDeviceId = deviceId;
        }

        if (deviceId && !approved) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "NOT_PAIRED",
                message: "pairing required",
                details: {
                  code: "PAIRING_REQUIRED",
                  requestId: pendingRequestId,
                  reason: "not-paired",
                },
              },
            }),
          );
          socket.close(1008, "pairing required");
          return;
        }

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: {
                methods: ["connect", "agent", "agent.wait", "device.pair.list", "device.pair.approve"],
                events: ["agent"],
              },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "device.pair.list") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              pending: approved
                ? []
                : [
                    {
                      requestId: pendingRequestId,
                      deviceId: lastSeenDeviceId ?? "device-unknown",
                    },
                  ],
              paired: approved && lastSeenDeviceId ? [{ deviceId: lastSeenDeviceId }] : [],
            },
          }),
        );
        return;
      }

      if (frame.method === "device.pair.approve") {
        const requestId = frame.params?.requestId;
        if (requestId !== pendingRequestId) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "unknown requestId" },
            }),
          );
          return;
        }
        approved = true;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              requestId: pendingRequestId,
              device: {
                deviceId: lastSeenDeviceId ?? "device-unknown",
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayload = frame.params ?? null;
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : "run-123";

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "ok" },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayload: () => agentPayload,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  // no global mocks
});

describe("openclaw gateway ui stdout parser", () => {
  it("parses assistant deltas from gateway event lines", () => {
    const ts = "2026-03-06T15:00:00.000Z";
    const line =
      '[openclaw-gateway:event] run=run-1 stream=assistant data={"delta":"hello"}';

    expect(parseOpenClawGatewayStdoutLine(line, ts)).toEqual([
      {
        kind: "assistant",
        ts,
        text: "hello",
        delta: true,
      },
    ]);
  });
});

describe("openclaw gateway adapter execute", () => {
  it("runs connect -> agent -> agent.wait and forwards wake payload", async () => {
    const gateway = await createMockGatewayServer();
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            headers: {
              "x-openclaw-token": "gateway-token",
            },
            payloadTemplate: {
              message: "wake now",
            },
            waitTimeoutMs: 2000,
          },
          {
            onLog: async (_stream, chunk) => {
              logs.push(chunk);
            },
            context: {
              taskId: "task-123",
              issueId: "issue-123",
              wakeReason: "issue_assigned",
              issueIds: ["issue-123"],
              paperclipWorkspace: {
                cwd: "/tmp/worktrees/pap-123",
                strategy: "git_worktree",
                branchName: "pap-123-test",
              },
              paperclipWorkspaces: [
                {
                  id: "workspace-1",
                  cwd: "/tmp/project",
                },
              ],
              paperclipRuntimeServiceIntents: [
                {
                  name: "preview",
                  lifecycle: "ephemeral",
                },
              ],
              paperclipWake: {
                reason: "issue_commented",
                issue: {
                  id: "issue-123",
                  identifier: "PAP-874",
                  title: "chat-speed issues",
                  status: "in_progress",
                  priority: "medium",
                },
                commentIds: ["comment-1", "comment-2"],
                latestCommentId: "comment-2",
                comments: [
                  {
                    id: "comment-1",
                    issueId: "issue-123",
                    body: "First comment",
                    bodyTruncated: false,
                    createdAt: "2026-03-28T14:35:00.000Z",
                    author: { type: "user", id: "user-1" },
                  },
                  {
                    id: "comment-2",
                    issueId: "issue-123",
                    body: "Second comment",
                    bodyTruncated: false,
                    createdAt: "2026-03-28T14:35:10.000Z",
                    author: { type: "user", id: "user-1" },
                  },
                ],
                commentWindow: {
                  requestedCount: 2,
                  includedCount: 2,
                  missingCount: 0,
                },
                truncated: false,
                fallbackFetchNeeded: false,
              },
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.summary).toContain("chachacha");
      expect(result.provider).toBe("openclaw");

      const payload = gateway.getAgentPayload();
      expect(payload).toBeTruthy();
      expect(payload?.idempotencyKey).toBe("run-123");
      expect(payload?.sessionKey).toBe("paperclip:issue:issue-123");
      expect(String(payload?.message ?? "")).toContain("wake now");
      expect(String(payload?.message ?? "")).toContain("PAPERCLIP_RUN_ID=run-123");
      expect(String(payload?.message ?? "")).toContain("PAPERCLIP_TASK_ID=task-123");
      expect(String(payload?.message ?? "")).toContain("## Paperclip Wake Payload");
      expect(String(payload?.message ?? "")).toContain(
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
      );
      expect(String(payload?.message ?? "")).toContain(
        "Do not switch to another issue until you have handled this wake.",
      );
      expect(String(payload?.message ?? "")).toContain("First comment");
      expect(String(payload?.message ?? "")).toContain("\"commentIds\":[\"comment-1\",\"comment-2\"]");
      expect(payload?.paperclip).toMatchObject({
        wake: {
          latestCommentId: "comment-2",
          commentIds: ["comment-1", "comment-2"],
        },
      });

      expect(logs.some((entry) => entry.includes("[openclaw-gateway:event] run=run-123 stream=assistant"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("fails fast when url is missing", async () => {
    const result = await execute(buildContext({}));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_gateway_url_missing");
  });

  it("returns adapter-managed runtime services from gateway result meta", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: {
        runId: "run-123",
        status: "ok",
        startedAt: 1,
        endedAt: 2,
        meta: {
          runtimeServices: [
            {
              name: "preview",
              scopeType: "run",
              url: "https://preview.example/run-123",
              providerRef: "sandbox-123",
              lifecycle: "ephemeral",
            },
          ],
        },
      },
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.runtimeServices).toEqual([
        expect.objectContaining({
          serviceName: "preview",
          scopeType: "run",
          url: "https://preview.example/run-123",
          providerRef: "sandbox-123",
          lifecycle: "ephemeral",
          status: "running",
        }),
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("auto-approves pairing once and retries the run", async () => {
    const gateway = await createMockGatewayServerWithPairing();
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            headers: {
              "x-openclaw-token": "gateway-token",
            },
            payloadTemplate: {
              message: "wake now",
            },
            waitTimeoutMs: 2000,
          },
          {
            onLog: async (_stream, chunk) => {
              logs.push(chunk);
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("ok");
      expect(logs.some((entry) => entry.includes("pairing required; attempting automatic pairing approval"))).toBe(
        true,
      );
      expect(logs.some((entry) => entry.includes("auto-approved pairing request"))).toBe(true);
      expect(gateway.getAgentPayload()).toBeTruthy();
    } finally {
      await gateway.close();
    }
  });
});

describe("openclaw gateway ui build config", () => {
  it("parses payload template and runtime services json", () => {
    const config = buildOpenClawGatewayConfig({
      adapterType: "openclaw_gateway",
      cwd: "",
      promptTemplate: "",
      model: "",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "wss://gateway.example/ws",
      payloadTemplateJson: JSON.stringify({
        agentId: "remote-agent-123",
        metadata: { team: "platform" },
      }),
      runtimeServicesJson: JSON.stringify({
        services: [
          {
            name: "preview",
            lifecycle: "shared",
          },
        ],
      }),
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: true,
      intervalSec: 300,
    });

    expect(config).toEqual(
      expect.objectContaining({
        url: "wss://gateway.example/ws",
        payloadTemplate: {
          agentId: "remote-agent-123",
          metadata: { team: "platform" },
        },
        workspaceRuntime: {
          services: [
            {
              name: "preview",
              lifecycle: "shared",
            },
          ],
        },
      }),
    );
  });
});

describe("openclaw gateway testEnvironment", () => {
  it("reports missing url as failure", async () => {
    const result = await testEnvironment({
      companyId: "company-123",
      adapterType: "openclaw_gateway",
      config: {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "openclaw_gateway_url_missing")).toBe(true);
  });
});
