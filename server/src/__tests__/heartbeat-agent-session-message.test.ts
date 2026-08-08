import { describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  buildAgentChainOfCommandSnapshot,
  buildPaperclipWakePayload,
} from "../services/heartbeat.js";

describe("agent session wake messages", () => {
  it("loads the reporting chain with one bounded query", async () => {
    const execute = vi.fn().mockResolvedValue([
      { id: "manager-1", name: "CTO", role: "cto", title: "Chief Technology Officer" },
      { id: "manager-2", name: "CEO", role: "ceo", title: null },
    ]);

    await expect(
      buildAgentChainOfCommandSnapshot({
        db: { execute } as never,
        agent: { id: "agent-1", companyId: "company-1", reportsTo: "manager-1" },
        runId: "run-1",
      }),
    ).resolves.toEqual([
      { id: "manager-1", name: "CTO", role: "cto", title: "Chief Technology Officer" },
      { id: "manager-2", name: "CEO", role: "ceo", title: null },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("continues a wake without reporting context when the hierarchy query fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));

    await expect(
      buildAgentChainOfCommandSnapshot({
        db: { execute } as never,
        agent: { id: "agent-1", companyId: "company-1", reportsTo: "manager-1" },
        runId: "run-1",
      }),
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips hierarchy lookup for top-level agents", async () => {
    const execute = vi.fn();

    await expect(
      buildAgentChainOfCommandSnapshot({
        db: { execute } as never,
        agent: { id: "agent-1", companyId: "company-1", reportsTo: null },
      }),
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("includes the issue brief and requires fallback fetch when a long description is truncated", async () => {
    const description = [
      "Update launch-card.svg and change the CTA to Try Team free.",
      "x".repeat(13_000),
    ].join("\n");

    const wakePayload = await buildPaperclipWakePayload({
      db: {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      } as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-1",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-15271",
        title: "Preserve the task brief",
        description,
        status: "in_progress",
        priority: "high",
        workMode: "standard",
      },
    });

    expect(wakePayload?.issue).toMatchObject({
      description: expect.stringContaining("launch-card.svg"),
      descriptionTruncated: true,
    });
    expect(wakePayload?.issue?.description).toContain("Try Team free");
    expect(wakePayload?.issue?.description).toHaveLength(12_000);
    expect(wakePayload).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
    });
  });

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

  it("materializes the agent chain of command and budget on context-only wakes", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: { wakeReason: "timer" },
      agentContext: {
        id: "agent-1",
        name: "Builder",
        role: "engineer",
        chainOfCommand: [
          { id: "manager-1", name: "CTO", role: "cto", title: "Chief Technology Officer" },
        ],
        budget: { monthlyCents: 10_000, spentCents: 2_500 },
      },
    });

    expect(wakePayload).toMatchObject({
      reason: "timer",
      issue: null,
      agentContext: {
        id: "agent-1",
        role: "engineer",
        chainOfCommand: [{ id: "manager-1", name: "CTO" }],
        budget: { monthlyCents: 10_000, spentCents: 2_500 },
      },
    });
    expect(renderPaperclipWakePrompt(wakePayload)).toContain(
      "- agent identity: Builder (agent-1); role: engineer; manager: CTO (manager-1); chain depth: 1",
    );
    expect(renderPaperclipWakePrompt(wakePayload)).toContain(
      "- monthly budget: $25.00 used / $100.00 (25% used)",
    );
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

  it("redacts and bounds session messages before materializing the wake payload", async () => {
    const secret = "do-not-render-this-value";
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: `OPENAI_API_KEY=${secret}\n${"x".repeat(13_000)}`,
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload?.agentMessage?.text).not.toContain(secret);
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(12_000);
  });
});
