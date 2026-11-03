import { describe, expect, it } from "vitest";

import {
  assertGmailArchiveToolArgumentsSupported,
  gmailArchiveToolDescription,
  gmailArchiveToolInputSchema,
} from "./gmail-archive-tool-policy.js";

const archive = { config: {
  sourceTemplateKey: "gmail",
  connectionMethodKey: "paperclip-archive",
  oauth: { connectorProfile: "gmail.archive" },
} };

describe("Gmail archive tool policy", () => {
  it("accepts only removal of the Inbox label from one thread", () => {
    expect(() => assertGmailArchiveToolArgumentsSupported(archive, "unlabel_thread", {
      threadId: "thread-123",
      labelIds: ["INBOX"],
    })).not.toThrow();

    for (const parameters of [
      { threadId: "thread-123", labelIds: ["STARRED"] },
      { threadId: "thread-123", labelIds: ["INBOX", "UNREAD"] },
      { threadId: "thread-123", label_ids: ["INBOX"] },
      { threadId: "", labelIds: ["INBOX"] },
      { threadId: "thread-123", labelIds: ["INBOX"], extra: true },
      "encoded",
    ]) {
      expect(() => assertGmailArchiveToolArgumentsSupported(archive, "unlabel_thread", parameters))
        .toThrow(expect.objectContaining({
          status: 400,
          details: { code: "gmail_archive_arguments_unsupported" },
        }));
    }
  });

  it("requires an explicit archive connection even for the official Gmail endpoint", () => {
    for (const config of [
      { sourceTemplateKey: "gmail", connectionMethodKey: "paperclip-read", oauth: { connectorProfile: "gmail.read" } },
      { sourceTemplateKey: "gmail", connectionMethodKey: "paperclip-draft", oauth: { connectorProfile: "gmail.draft" } },
      { url: "https://gmailmcp.googleapis.com/mcp/v1" },
    ]) {
      expect(() => assertGmailArchiveToolArgumentsSupported({ config }, "unlabel_thread", {
        threadId: "thread-123", labelIds: ["INBOX"],
      })).toThrow(expect.objectContaining({
        status: 400,
        details: { code: "gmail_archive_profile_required" },
      }));
    }
  });

  it("publishes an Inbox-only schema without mutating the provider schema", () => {
    const providerSchema = { type: "object", properties: {
      threadId: { type: "string" },
      labelIds: { type: "array", items: { type: "string" } },
    } };
    const projected = gmailArchiveToolInputSchema(archive, "gmail/unlabel_thread", providerSchema);
    expect(projected).toMatchObject({
      properties: { labelIds: { items: { enum: ["INBOX"] }, minItems: 1, maxItems: 1 } },
      required: ["threadId", "labelIds"],
      additionalProperties: false,
    });
    expect(providerSchema.properties.labelIds.items).toEqual({ type: "string" });
  });

  it("describes archive narrowly and leaves unrelated tools unchanged", () => {
    expect(gmailArchiveToolDescription(archive, "unlabel_thread", "Remove labels."))
      .toContain("removing only its Inbox label");
    expect(gmailArchiveToolDescription(archive, "search_threads", "Search mail."))
      .toBe("Search mail.");
    expect(() => assertGmailArchiveToolArgumentsSupported(
      { config: { sourceTemplateKey: "other" } },
      "unlabel_thread",
      { anything: true },
    )).not.toThrow();
  });
});
