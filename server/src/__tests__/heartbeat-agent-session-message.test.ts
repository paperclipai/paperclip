import { describe, expect, it } from "vitest";
import { issueThreadInteractions } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

describe("agent session wake messages", () => {
  it("materializes answered questions at run preparation without content-bearing wake context", async () => {
    const interaction = {
      id: "interaction-1",
      sourceRunId: "source-run-1",
      title: "Candidate materials needed",
      kind: "ask_user_questions",
      status: "answered",
      payload: {
        version: 1,
        questions: [
          {
            id: "candidate_context",
            prompt: "Please provide the candidate context.",
            selectionMode: "single",
            required: true,
            options: [],
          },
        ],
      },
      result: {
        version: 1,
        answers: [
          {
            questionId: "candidate_context",
            optionIds: [],
            otherText: "Alex Chen has seven years of B2B SaaS product experience.",
          },
        ],
      },
    };
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const rows = table === issueThreadInteractions ? [interaction] : [];
          const query: Record<string, unknown> = {};
          const finish = () => Promise.resolve(rows);
          query.where = finish;
          query.orderBy = finish;
          query.limit = finish;
          query.innerJoin = () => query;
          query.leftJoin = () => query;
          query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject);
          return query;
        },
      }),
    };
    const contextSnapshot = {
      wakeReason: "issue_commented",
      issueId: "issue-1",
      interactionId: interaction.id,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
    };

    expect(JSON.stringify(contextSnapshot)).not.toContain("Alex Chen");
    const wakePayload = await buildPaperclipWakePayload({
      db: db as never,
      companyId: "company-1",
      contextSnapshot,
      issueSummary: {
        id: "issue-1",
        identifier: "JAW-2",
        title: "Draft hiring recommendation for Maya",
        description: "Prepare the decision brief.",
        status: "in_progress",
        priority: "critical",
        workMode: "standard",
      },
    });

    expect(wakePayload?.agentMessage).toMatchObject({
      source: "question_response",
      text: expect.stringContaining("Alex Chen has seven years"),
    });
    expect(wakePayload?.fallbackFetchNeeded).toBe(false);
    expect(renderPaperclipWakePrompt(wakePayload)).toContain("Alex Chen has seven years");
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
