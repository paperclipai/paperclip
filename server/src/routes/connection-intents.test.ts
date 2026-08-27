import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTION_RUNTIME_TOOL_NAMES,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
} from "@paperclipai/shared";
import {
  RUNTIME_CONNECTION_TOOL_DEFINITIONS,
  wakeConnectionIntentAfterResolution,
} from "./connection-intents.js";

describe("runtime connection MCP contract", () => {
  it("advertises both canonical tools with the shared descriptions and narrow schemas", () => {
    expect(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map((tool) => tool.name),
    ).toEqual(CONNECTION_RUNTIME_TOOL_NAMES);
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS).toEqual([
      {
        name: "connections_search",
        description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "connection_request",
        description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("does not accept run identity, task identity, users, or credentials from tool input", () => {
    const serialized = JSON.stringify(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map(
        (definition) => definition.inputSchema,
      ),
    );
    expect(serialized).not.toMatch(
      /companyId|agentId|runId|issueId|responsibleUserId|credential|token/i,
    );
  });
});

describe("connection intent continuation wake contract", () => {
  it.each([
    ["accepted", "connected"],
    ["rejected", "declined"],
  ])(
    "emits one idempotent continuation wake for %s intents",
    async (status) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-123",
            assigneeAgentId: "agent-123",
            status: "in_progress",
          },
          interaction: { id: "interaction-123" },
        },
        status,
        actorId: "user-123",
      });

      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(
        "agent-123",
        expect.objectContaining({
          idempotencyKey: `interaction:interaction-123:${status}`,
          requestedByActorType: "user",
          requestedByActorId: "user-123",
          contextSnapshot: expect.objectContaining({
            issueId: "issue-123",
            interactionId: "interaction-123",
            interactionStatus: status,
            forceFreshSession: true,
          }),
        }),
      );
    },
  );

  it.each(["done", "cancelled"])(
    "does not wake a %s task",
    async (issueStatus) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-closed",
            assigneeAgentId: "agent-123",
            status: issueStatus,
          },
          interaction: { id: "interaction-123" },
        },
        status: "accepted",
        actorId: "user-123",
      });

      expect(wakeup).not.toHaveBeenCalled();
    },
  );
});
