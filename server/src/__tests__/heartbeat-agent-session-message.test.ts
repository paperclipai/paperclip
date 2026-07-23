import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

describe("agent session wake messages", () => {
  it("turns the canonical session-message context into adapter prompt input", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: "hello",
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload).toMatchObject({
      reason: "gateway_chat_message",
      issue: null,
      agentMessage: {
        text: "hello",
        source: "plugin_session",
        pluginKey: "paperclip.gateway",
        sessionId: "session-1",
      },
    });
    expect(renderPaperclipWakePrompt(wakePayload)).toContain("hello");
  });

  it("leaves a normal context-only wake without a renderable payload", async () => {
    await expect(
      buildPaperclipWakePayload({
        db: {} as never,
        companyId: "company-1",
        contextSnapshot: {
          wakeReason: "timer",
        },
      }),
    ).resolves.toBeNull();
  });
});
