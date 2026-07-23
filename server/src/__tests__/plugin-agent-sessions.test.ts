import { describe, expect, it, vi } from "vitest";
import { publishLiveEvent } from "../services/live-events.js";

const mockWakeup = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => vi.fn(() => ({ wakeup: mockWakeup })));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: mockHeartbeatService,
}));

import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

function createSessionLookupDb(session: {
  id: string;
  companyId: string;
  agentId: string;
  taskKey: string;
}) {
  const query = {
    from: () => query,
    where: () => query,
    then: (resolve: (rows: typeof session[]) => unknown) => Promise.resolve(resolve([session])),
  };
  return {
    select: () => query,
  } as never;
}

describe("plugin agent sessions", () => {
  it("delivers the message body in wake context and returns final assistant text on done", async () => {
    const companyId = "company-1";
    const agentId = "agent-1";
    const sessionId = "session-1";
    const notifyWorker = vi.fn();
    mockWakeup.mockReset();
    mockWakeup.mockResolvedValue({ id: "run-1" });

    const services = buildHostServices(
      createSessionLookupDb({
        id: sessionId,
        companyId,
        agentId,
        taskKey: "plugin:paperclip.gateway:session:session-1",
      }),
      "plugin-record-id",
      "paperclip.gateway",
      createEventBusStub(),
      notifyWorker,
    );

    await expect(
      services.agentSessions.sendMessage({
        sessionId,
        companyId,
        prompt: "hello",
        reason: "gateway_chat_message",
      }),
    ).resolves.toEqual({ runId: "run-1" });

    expect(mockWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        payload: { prompt: "hello" },
        contextSnapshot: {
          taskKey: "plugin:paperclip.gateway:session:session-1",
          wakeSource: "automation",
          wakeTriggerDetail: "system",
          paperclipAgentMessage: {
            text: "hello",
            source: "plugin_session",
            pluginKey: "paperclip.gateway",
            sessionId,
          },
        },
      }),
    );

    publishLiveEvent({
      companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: "run-1",
        status: "succeeded",
        finalText: "Hello! How can I help?",
      },
    });

    expect(notifyWorker).toHaveBeenCalledWith(
      "agents.sessions.event",
      expect.objectContaining({
        sessionId,
        runId: "run-1",
        eventType: "done",
        message: "Hello! How can I help?",
      }),
    );

    services.dispose();
  });
});
