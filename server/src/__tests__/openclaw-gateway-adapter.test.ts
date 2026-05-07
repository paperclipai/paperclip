import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { execute, testEnvironment } from "@paperclipai/adapter-openclaw-gateway/server";
import * as openClawGateway from "@paperclipai/adapter-openclaw-gateway";
import {
  buildOpenClawGatewayConfig,
  parseOpenClawGatewayStdoutLine,
} from "@paperclipai/adapter-openclaw-gateway/ui";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function extractStructuredWakePayload(message: unknown): Record<string, unknown> | null {
  const text = String(message ?? "");
  const marker = "Structured wake payload JSON:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const jsonStart = text.indexOf("```json", markerIndex);
  if (jsonStart < 0) return null;
  const bodyStart = text.indexOf("\n", jsonStart);
  if (bodyStart < 0) return null;
  const fenceEnd = text.indexOf("\n```", bodyStart);
  if (fenceEnd < 0) return null;
  const json = text.slice(bodyStart + 1, fenceEnd).trim();
  if (!json) return null;
  return JSON.parse(json) as Record<string, unknown>;
}

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
  artifactListPayload?: Record<string, unknown> | unknown[];
  artifactDownloads?: Record<string, Record<string, unknown>>;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;
  let connectScopes: unknown = null;

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
        connectScopes = frame.params?.scopes ?? null;
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
        return;
      }

      if (frame.method === "artifacts.list") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: options?.artifactListPayload ?? { artifacts: [] },
          }),
        );
        return;
      }

      if (frame.method === "artifacts.download") {
        const key = String(frame.params?.sourcePath ?? frame.params?.path ?? frame.params?.artifactId ?? frame.params?.id ?? "");
        const payload = options?.artifactDownloads?.[key];
        if (!payload) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "NOT_FOUND", message: `no artifact payload for ${key}` },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload,
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
    getConnectScopes: () => connectScopes,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createMockGatewayServerWithPairing(options?: {
  rejectDeviceAgentForMissingWriteScope?: boolean;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;
  let approved = false;
  let pendingRequestId = "req-1";
  let lastSeenDeviceId: string | null = null;
  let currentConnectionHasDevice = false;

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
        currentConnectionHasDevice = Boolean(deviceId);
        if (deviceId) {
          lastSeenDeviceId = deviceId;
        }

        if (deviceId && !approved && !options?.rejectDeviceAgentForMissingWriteScope) {
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
        if (options?.rejectDeviceAgentForMissingWriteScope && currentConnectionHasDevice) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "missing scope: operator.write",
              },
            }),
          );
          return;
        }
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
    getLastSeenDeviceId: () => lastSeenDeviceId,
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
              paperclip: {
                shouldNotSend: true,
              },
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
      expect(payload?.role).toBeUndefined();
      expect(payload?.scopes).toBeUndefined();
      expect(String(payload?.message ?? "")).toContain("wake now");
      expect(String(payload?.message ?? "")).toContain("BIZBOX_RUN_ID=run-123");
      expect(String(payload?.message ?? "")).toContain("BIZBOX_TASK_ID=task-123");
      expect(String(payload?.message ?? "")).toContain("## Paperclip Wake Payload");
      expect(String(payload?.message ?? "")).toContain(
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
      );
      expect(String(payload?.message ?? "")).toContain(
        "Do not switch to another issue until you have handled this wake.",
      );
      expect(String(payload?.message ?? "")).toContain("First comment");
      expect(String(payload?.message ?? "")).toContain("\"commentIds\":[\"comment-1\",\"comment-2\"]");
      expect(String(payload?.message ?? "")).toContain("\"latestCommentId\":\"comment-2\"");
      expect(payload?.paperclip).toBeUndefined();
      expect(extractStructuredWakePayload(payload?.message)).toMatchObject({
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
        requestedCount: 2,
        includedCount: 2,
        missingCount: 0,
      });

      expect(logs.some((entry) => entry.includes("[openclaw-gateway:event] run=run-123 stream=assistant"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("uses default gateway scopes when scopes are omitted", async () => {
    const gateway = await createMockGatewayServer();

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          authToken: "gateway-token",
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(gateway.getConnectScopes()).toEqual(["operator.admin", "operator.write"]);
      expect(gateway.getAgentPayload()?.scopes).toBeUndefined();
    } finally {
      await gateway.close();
    }
  });

  it("uses the Builder prompt as the outbound gateway message in Builder mode", async () => {
    const gateway = await createMockGatewayServer();

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            authToken: "gateway-token",
            payloadTemplate: {
              message: "Builder preface",
            },
            waitTimeoutMs: 2000,
          },
          {
            context: {
              executionMode: "builder",
              builderInvocationId: "builder-turn-123",
              prompt: "Return strict JSON only.",
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(gateway.getAgentPayload()).toEqual(
        expect.objectContaining({
          sessionKey: "paperclip:builder:builder-turn-123",
          message: "Builder preface\n\nReturn strict JSON only.",
        }),
      );
      expect(extractStructuredWakePayload(gateway.getAgentPayload()?.message)).toBeNull();
    } finally {
      await gateway.close();
    }
  });

  it("isolates OpenClaw Builder turns with per-turn session keys", async () => {
    const firstGateway = await createMockGatewayServer();
    const secondGateway = await createMockGatewayServer();

    try {
      await execute(
        buildContext(
          {
            url: firstGateway.url,
            authToken: "gateway-token",
            agentId: "meridian",
            waitTimeoutMs: 2000,
          },
          {
            context: {
              executionMode: "builder",
              builderInvocationId: "turn-1",
              prompt: "First prompt",
            },
          },
        ),
      );
      await execute(
        buildContext(
          {
            url: secondGateway.url,
            authToken: "gateway-token",
            agentId: "meridian",
            waitTimeoutMs: 2000,
          },
          {
            context: {
              executionMode: "builder",
              builderInvocationId: "turn-2",
              prompt: "Second prompt",
            },
          },
        ),
      );

      expect(firstGateway.getAgentPayload()?.sessionKey).toBe(
        "agent:meridian:paperclip:builder:turn-1",
      );
      expect(secondGateway.getAgentPayload()?.sessionKey).toBe(
        "agent:meridian:paperclip:builder:turn-2",
      );
    } finally {
      await firstGateway.close();
      await secondGateway.close();
    }
  });

  it("preserves explicit gateway scopes", async () => {
    const gateway = await createMockGatewayServer();

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          authToken: "gateway-token",
          scopes: ["operator.admin"],
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(gateway.getConnectScopes()).toEqual(["operator.admin"]);
      expect(gateway.getAgentPayload()?.scopes).toBeUndefined();
    } finally {
      await gateway.close();
    }
  });

  it("preserves custom read-only gateway scopes", async () => {
    const gateway = await createMockGatewayServer();

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          authToken: "gateway-token",
          scopes: ["read_only"],
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(gateway.getConnectScopes()).toEqual(["read_only"]);
      expect(gateway.getAgentPayload()?.scopes).toBeUndefined();
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

  it("collects declared artifact outputs through gateway artifact RPCs", async () => {
    const gateway = await createMockGatewayServer({
      artifactListPayload: {
        artifacts: [
          {
            id: "artifact-1",
            sourcePath: "deliverables/final-packet.md",
            contentType: "text/markdown",
          },
          {
            id: "artifact-2",
            sourcePath: "deliverables/articles/post-1.md",
            contentType: "text/markdown",
          },
        ],
      },
      artifactDownloads: {
        "deliverables/final-packet.md": {
          contentType: "text/markdown",
          bodyBase64: Buffer.from("# Final packet\n", "utf8").toString("base64"),
        },
        "deliverables/articles/post-1.md": {
          contentType: "text/markdown",
          bodyBase64: Buffer.from("# Article\n", "utf8").toString("base64"),
        },
      },
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          authToken: "gateway-token",
          artifactOutputs: [
            { pattern: "deliverables/final-packet.md", title: "Final packet", primary: true },
            { pattern: "deliverables/articles/*.md", title: "Article draft" },
          ],
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          title: "Final packet",
          sourcePath: "deliverables/final-packet.md",
          contentType: "text/markdown",
          byteSize: Buffer.byteLength("# Final packet\n"),
          isPrimary: true,
        }),
        expect.objectContaining({
          title: "Article draft",
          sourcePath: "deliverables/articles/post-1.md",
          contentType: "text/markdown",
          byteSize: Buffer.byteLength("# Article\n"),
          isPrimary: false,
        }),
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("deduplicates repeated artifact pattern matches and skips invalid patterns", async () => {
    const gateway = await createMockGatewayServer({
      artifactListPayload: {
        artifacts: [
          {
            id: "artifact-1",
            sourcePath: "deliverables/final-packet.md",
            contentType: "text/markdown",
          },
        ],
      },
      artifactDownloads: {
        "deliverables/final-packet.md": {
          contentType: "text/markdown",
          bodyBase64: Buffer.from("# Final packet\n", "utf8").toString("base64"),
        },
      },
    });
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            authToken: "gateway-token",
            artifactOutputs: [
              { pattern: "deliverables/*.md" },
              { pattern: "deliverables/final-packet.md" },
              { pattern: "../escape.md" },
            ],
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
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts?.[0]?.sourcePath).toBe("deliverables/final-packet.md");
      expect(logs.some((entry) => entry.includes("artifact download failed"))).toBe(false);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the run successful when declared artifact outputs are missing", async () => {
    const gateway = await createMockGatewayServer({
      artifactListPayload: {
        artifacts: [],
      },
    });
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            authToken: "gateway-token",
            artifactOutputs: [{ pattern: "deliverables/*.md" }],
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
      expect(result.artifacts).toBeUndefined();
      expect(logs.some((entry) => entry.includes("no artifact matched"))).toBe(false);
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
            disableDeviceAuth: false,
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

  it("defaults missing disableDeviceAuth to token-only mode", async () => {
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
      expect(logs.some((entry) => entry.includes("device auth disabled (token-only mode)"))).toBe(true);
      expect(logs.some((entry) => entry.includes("pairing required; attempting automatic pairing approval"))).toBe(
        false,
      );
    } finally {
      await gateway.close();
    }
  });

  it("preserves device auth for legacy configs that only carry a device key", async () => {
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
            devicePrivateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAkVCxwSIYiI1yMZ1EeURcKn8S8VyMW3Wj+zgIKp+AtK
-----END PRIVATE KEY-----`,
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
      expect(logs.some((entry) => entry.includes("device auth enabled"))).toBe(true);
      expect(logs.some((entry) => entry.includes("pairing required; attempting automatic pairing approval"))).toBe(
        true,
      );
    } finally {
      await gateway.close();
    }
  });

  it("retries token-only when paired device lacks operator.write", async () => {
    const gateway = await createMockGatewayServerWithPairing({
      rejectDeviceAgentForMissingWriteScope: true,
    });
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            headers: {
              "x-openclaw-token": "gateway-token",
            },
            disableDeviceAuth: false,
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
      expect(gateway.getAgentPayload()).toBeTruthy();
      expect(gateway.getLastSeenDeviceId()).toBeTruthy();
      expect(logs.some((entry) => entry.includes("device auth enabled"))).toBe(true);
      expect(
        logs.some((entry) =>
          entry.includes("device auth lacks operator.write; retrying once in token-only mode"),
        ),
      ).toBe(true);
      expect(logs.some((entry) => entry.includes("device auth disabled (token-only mode)"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });
});

describe("openclaw gateway ui build config", () => {
  it("documents the current outbound payload contract", () => {
    expect(openClawGateway.type).toBe("openclaw_gateway");
    expect(openClawGateway.agentConfigurationDoc).not.toContain("paperclip (object)");
    expect(openClawGateway.agentConfigurationDoc).not.toContain("paperclip.workspace");
    expect(openClawGateway.agentConfigurationDoc).toContain("Wake context is included in the structured wake message/text");
    expect(openClawGateway.agentConfigurationDoc).toContain("Do not rely on a top-level paperclip params object");
  });

  it("builds the simplified connect config with hidden defaults", () => {
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
      accessToken: "gateway-token",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: true,
      intervalSec: 300,
    });

    expect(config).toEqual(
      expect.objectContaining({
        url: "wss://gateway.example/ws",
        authToken: "gateway-token",
        disableDeviceAuth: true,
        waitTimeoutMs: 120000,
        sessionKeyStrategy: "issue",
        role: "operator",
        scopes: ["operator.admin", "operator.write"],
      }),
    );
  });

  it("persists pairing mode when explicitly selected", () => {
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
      accessToken: "gateway-token",
      openClawSetupMode: "token_and_device_pairing",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: true,
      intervalSec: 300,
    });

    expect(config.disableDeviceAuth).toBe(false);
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
