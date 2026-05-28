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

describe("clickup awaiting human transport request_confirmation", () => {
  it("renders body with bizbox open line", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: "message-42" } }),
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
          "Need human confirmation before creating new dev company project.",
          "",
          "If accepted: proceed with setup work.",
          "If rejected: collect changes, revise, and re-request confirmation.",
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
    expect(body.content).not.toContain("Open in Bizbox: https://bizbox.example/issues/CIT-3");
    expect(body.content).not.toContain("Disclaimer:");
    expect(body.content).not.toContain("It is your responsibility to read and verify this content.");
    expect(body.content.match(/Need human confirmation before creating new dev company project\./g) ?? []).toHaveLength(1);
  });
});
