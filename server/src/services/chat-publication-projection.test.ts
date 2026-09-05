import { describe, expect, it } from "vitest";
import {
  UnsafeChatPublicationError,
  projectSafeChatPublication,
  projectSafeChatPublicationText,
  sanitizeExternalChatUrl,
} from "./chat-publication-projection.js";

describe("chat publication projection", () => {
  it("removes reasoning, internal blocks, tool traces, and debug logs", () => {
    const input = [
      "Public summary.",
      "<analysis>secret deliberation</analysis>",
      "```tool_trace",
      "called dangerous_tool",
      "```",
      "## Internal notes",
      "do not publish this",
      "### Nested detail",
      "still private",
      "## Result",
      "Shipped safely.",
      "[DEBUG] raw provider response",
      "Reasoning: hidden one-line thought",
    ].join("\n");

    expect(projectSafeChatPublicationText(input)).toBe(
      "Public summary.\n\n## Result\nShipped safely.",
    );
  });

  it("redacts common credentials and private connection material", () => {
    const slackTokenCanary = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    const openAiKeyCanary = ["sk", "proj", "abcdefghijklmnopqrstuv"].join("-");
    const input = [
      `token: ${slackTokenCanary}`,
      `key ${openAiKeyCanary}`,
      "database postgresql://paperclip:hunter2@example.com/db",
      "-----BEGIN PRIVATE KEY-----",
      "definitely-private",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const projected = projectSafeChatPublicationText(input);
    expect(projected).not.toContain("xoxb-");
    expect(projected).not.toContain("sk-proj-");
    expect(projected).not.toContain("hunter2");
    expect(projected).not.toContain("definitely-private");
    expect(projected).toContain("[REDACTED]");
  });

  it("keeps HTTPS links but removes credentials, queries, fragments, and unsafe schemes", () => {
    const projected = projectSafeChatPublicationText(
      "Read [the report](https://docs.example.com/report?token=secret#private), " +
        "visit https://example.com/a?signature=abc#fragment, or javascript:alert(1).",
    );

    expect(projected).toContain("[the report](https://docs.example.com/report)");
    expect(projected).toContain("https://example.com/a");
    expect(projected).not.toContain("secret");
    expect(projected).not.toContain("signature");
    expect(projected).not.toContain("fragment");
    expect(projected).not.toContain("javascript:");
  });

  it("accepts only public HTTPS display links", () => {
    expect(sanitizeExternalChatUrl("https://example.com/path?q=secret#part")).toBe(
      "https://example.com/path",
    );
    expect(sanitizeExternalChatUrl("http://example.com/path")).toBeNull();
    expect(sanitizeExternalChatUrl("https://user:secret@example.com/path")).toBeNull();
    expect(sanitizeExternalChatUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeExternalChatUrl("https://localhost/private")).toBeNull();
    expect(sanitizeExternalChatUrl("https://192.168.1.8/private")).toBeNull();
  });

  it("neutralizes provider-wide mentions", () => {
    const projected = projectSafeChatPublicationText(
      "Notify @channel, @everyone, @here, and <!group>.",
    );
    expect(projected).toBe(
      "Notify @\u200bchannel, @\u200beveryone, @\u200bhere, and @\u200bgroup.",
    );
  });

  it("uses a safe fallback if only private material remains", () => {
    expect(projectSafeChatPublicationText("<thinking>all private</thinking>")).toBe(
      "Update available in Paperclip.",
    );
  });

  it("projects a classified payload with deduplicated attachments and a closed card schema", () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "issue_interaction",
      text: "Please choose.",
      attachmentIds: [attachmentId, attachmentId.toUpperCase()],
      progressState: "waiting_for_input",
      interaction: {
        id: "interaction:123",
        card: {
          kind: "question",
          title: "Choose a path",
          body: "Do not leak token: super-secret-value",
          actions: [
            { type: "callback", actionId: "choice.one", label: "First", style: "primary" },
            {
              type: "link",
              label: "Open Paperclip",
              url: "https://paperclip.example/tasks/123?handoff=secret#private",
            },
            { type: "link", label: "Unsafe", url: "javascript:alert(1)" },
          ],
        },
      },
    });

    expect(payload).toEqual({
      text: "Please choose.",
      attachmentIds: [attachmentId],
      progressState: "waiting_for_input",
      interactionId: "interaction:123",
      card: {
        schema: "paperclip.chat.card.v1",
        kind: "question",
        title: "Choose a path",
        body: "Do not leak token: [REDACTED]",
        actions: [
          { type: "callback", actionId: "choice.one", label: "First", style: "primary" },
          {
            type: "link",
            label: "Open Paperclip",
            url: "https://paperclip.example/tasks/123",
          },
        ],
      },
    });
  });

  it("fails closed for malformed attachment and callback ids", () => {
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "agent_comment",
        text: "Result",
        attachmentIds: ["../../other-company-secret"],
      }),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "issue_interaction",
        text: "Result",
        interaction: {
          id: "valid-id",
          card: {
            kind: "confirmation",
            title: "Proceed?",
            actions: [{ type: "callback", actionId: "bad action id", label: "Yes" }],
          },
        },
      }),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "issue_interaction",
        text: "Result",
        interaction: {
          id: "valid-id",
          card: {
            kind: "confirmation",
            title: "Proceed?",
            actions: [
              { type: "callback", actionId: "approve", label: "Yes", style: "rainbow" },
            ],
          },
        },
      } as never),
    ).toThrow(UnsafeChatPublicationError);
  });

  it("requires explicit external classification and closed enum values at runtime", () => {
    expect(() =>
      projectSafeChatPublication({
        classification: "internal",
        source: "agent_comment",
        text: "Private",
      } as never),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "agent_comment",
        text: "Update",
        progressState: "raw_tool_trace",
      } as never),
    ).toThrow(UnsafeChatPublicationError);
  });

  it("truncates without splitting a Unicode code point", () => {
    const projected = projectSafeChatPublicationText(`${"a".repeat(39_999)}😀tail`);
    expect(Array.from(projected)).toHaveLength(40_000);
    expect(projected.endsWith("😀")).toBe(true);
  });
});
