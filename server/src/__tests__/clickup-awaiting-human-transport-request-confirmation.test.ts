import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAwaitingHumanNotification } from "../services/clickup-awaiting-human-transport.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  delete process.env.CLICKUP_PERSONAL_TOKEN;
  delete process.env.CLICKUP_WORKSPACE_ID;
  delete process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID;
});

describe("clickup awaiting human transport handoff messages", () => {
  it("renders request_confirmation with body and bizbox open line", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "message-42" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "CIT-3 needs confirmation",
        summary: "Need human confirmation before creating new dev company project.",
        link: "https://bizbox.example/issues/CIT-3",
        cta: "",
        labels: ["awaiting_human", "request_confirmation"],
        kind: "request_confirmation",
        body: [
          "Proceed with new dev company project setup?",
          "",
          "If accepted: proceed with setup work.",
          "If rejected: collect changes, revise, and re-request confirmation.",
          "",
          "Open in Bizbox: https://bizbox.example/issues/CIT-3",
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-42",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("Proceed with new dev company project setup?");
    expect(body.content).toContain("If accepted: proceed with setup work.");
    expect(body.content).toContain("Open in Bizbox: https://bizbox.example/issues/CIT-3");
  });

  it("renders ClickUp attachment url when review file was uploaded", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "message-44" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "CIT-8 needs review",
        summary: "Review uploaded file.",
        link: "https://bizbox.example/issues/CIT-8",
        cta: "",
        labels: ["awaiting_human", "request_confirmation"],
        reviewFile: {
          source: "artifact",
          deliverableId: "deliverable-1",
          title: "Review image",
          filename: "review.png",
          contentType: "image/png",
          byteSize: 14697,
          contentPath: "/api/attachments/deliverable-1/content",
          deliverableUrl: "https://bizbox.example/api/attachments/deliverable-1/content",
          clickupAttachmentId: "attachment-1",
          clickupAttachmentUrl: "https://app.clickup.com/attachment/1",
        },
      },
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("CIT-8 needs review");
    expect(body.content).toContain("Review file: review.png");
    expect(body.content).toContain("ClickUp attachment: https://app.clickup.com/attachment/1");
  });


  it("includes the target ClickUp attachment url in the full handoff message", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "message-45" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "CIT-9 needs review",
        summary: "Should not appear in chat.",
        link: "https://bizbox.example/issues/CIT-9",
        cta: "",
        labels: ["awaiting_human", "request_confirmation"],
        body: "Proceed?",
        target: {
          label: "Spec",
          href: "/api/attachments/target-1/content",
          clickupAttachmentUrl: "https://app.clickup.com/attachment/2",
        },
      },
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("CIT-9 needs review");
    expect(body.content).toContain("Proceed?");
    expect(body.content).toContain("ClickUp attachment: https://app.clickup.com/attachment/2");
    expect(body.content).not.toContain("Should not appear in chat.");
  });

  it("renders ask_user_questions with body and bizbox open line", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: "message-43" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "CIT-7 needs answers",
        summary: "Need answers to 2 question(s).",
        link: "http://127.0.0.1:3200/issues/CIT-7",
        cta: "Reply with the needed answers.",
        labels: ["awaiting_human", "ask_user_questions"],
        kind: "ask_user_questions",
        body: [
          "1. Which environment should we use?",
          "2. Who owns rollout?",
          "",
          "Open in Bizbox: http://127.0.0.1:3200/issues/CIT-7",
        ].join("\n"),
      },
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("Which environment should we use?");
    expect(body.content).toContain("Open in Bizbox: http://127.0.0.1:3200/issues/CIT-7");
    expect(body.content).not.toContain("Reply with the needed answers.");
  });

  it("keeps every handoff body line instead of limiting the number of questions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: "message-44" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const finalQuestion = "Question 31: Is this still included?";

    await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "CIT-8 needs answers",
        summary: "Need answers.",
        link: "",
        cta: "",
        labels: ["awaiting_human", "ask_user_questions"],
        body: Array.from({ length: 31 }, (_, index) =>
          index === 30 ? finalQuestion : `Question ${index + 1}: Please answer.`,
        ).join("\n"),
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain(finalQuestion);
  });

  it("does not truncate long handover content", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: "message-45" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const title = `Handover ${"title ".repeat(30)}`;
    const finalDetail = "This final handover detail must be preserved.";

    await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title,
        summary: "Need answers.",
        link: "",
        cta: "",
        labels: ["awaiting_human", "ask_user_questions"],
        body: `${"Detailed handover context. ".repeat(100)}${finalDetail}`,
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content.length).toBeGreaterThan(1_800);
    expect(body.content).toContain(title.trim());
    expect(body.content).toContain(finalDetail);
  });

  it("truncates oversized handovers at ClickUp's message limit", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: "message-46" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "Oversized handover",
        summary: "Need answers.",
        link: "",
        cta: "",
        labels: ["awaiting_human", "ask_user_questions"],
        body: "x".repeat(40_100),
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toHaveLength(40_000);
    expect(body.content).toMatch(/…$/);
  });
});
