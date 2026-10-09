import { describe, expect, it } from "vitest";
import {
  assertGoogleChatToolArgumentsSupported,
  googleChatToolDescription,
  googleChatToolInputSchema,
} from "./google-chat-tool-policy.js";

const chat = { config: { sourceTemplateKey: "google-chat" } };

describe("Google Chat search without read-state permission", () => {
  it.each([true, false, null, "true"])("rejects explicit unread filters (%s)", (isUnread) => {
    for (const tool of ["search_messages", "chat.searchMessages", "google/chat/search-messages"]) {
      for (const args of [
        { searchParameters: { isUnread } },
        { searchParameters: { is_unread: isUnread } },
        { search_parameters: { isUnread } },
        { search_parameters: { is_unread: isUnread } },
        { isUnread },
      ]) {
        expect(() => assertGoogleChatToolArgumentsSupported(chat, tool, args)).toThrow(
          expect.objectContaining({ status: 400, details: { code: "google_chat_unread_filter_unsupported" } }),
        );
      }
    }
  });

  it("covers legacy profile-bound and URL-only connections without inspecting granted scopes", () => {
    for (const config of [
      { oauth: { connectorProfile: "chat.read" } },
      { oauth: { connectorProfile: "chat.write" } },
      { url: "https://chatmcp.googleapis.com/mcp/v1" },
    ]) {
      expect(() => assertGoogleChatToolArgumentsSupported({ config }, "search_messages", {
        searchParameters: { isUnread: true },
      })).toThrow("read/unread filtering is not supported");
    }
  });

  it("rejects encoded filters instead of forwarding an invalid searchParameters value", () => {
    for (const searchParameters of ['{"isUnread":true}', "is:unread", [], null, true]) {
      expect(() => assertGoogleChatToolArgumentsSupported(chat, "search_messages", { searchParameters }))
        .toThrow("searchParameters must be an object");
    }
  });

  it("preserves supported search filters and unrelated providers/tools", () => {
    const args = { searchParameters: {
      keywords: ["release", "unread"], conversationId: "spaces/example", sender: "users/me",
      startTime: "2026-09-22T00:00:00Z", hasLink: true, mentionsMe: true,
      conversationIncludesUser: "users/example", spaceDisplayNames: ["Engineering"],
    }, pageSize: 10, pageToken: "next" };
    expect(() => assertGoogleChatToolArgumentsSupported(chat, "search_messages", args)).not.toThrow();
    expect(() => assertGoogleChatToolArgumentsSupported(chat, "send_message", { text: "isUnread" })).not.toThrow();
    const gmail = { config: { sourceTemplateKey: "gmail" } };
    expect(() => assertGoogleChatToolArgumentsSupported(gmail, "search_messages", {
      searchParameters: { isUnread: true },
    })).not.toThrow();
  });

  it("removes unsupported fields from inline and referenced schemas without mutating the cached schema", () => {
    const filters = { type: "object", required: ["isUnread", "keywords"], properties: {
      isUnread: { type: "boolean" }, is_unread: { type: "boolean" },
      keywords: { type: "array", items: { type: "string" } },
    } };
    const schema = { type: "object", properties: {
      searchParameters: filters,
      search_parameters: { anyOf: [{ $ref: "#/$defs/SearchParameters" }, { type: "null" }] },
      pageSize: { type: "integer" },
    }, $defs: { SearchParameters: filters } };
    const reduced = googleChatToolInputSchema(chat, "search_messages", schema);
    const expectedFilters = { ...filters, required: ["keywords"], properties: { keywords: filters.properties.keywords } };
    expect(reduced).toMatchObject({
      properties: { searchParameters: expectedFilters, pageSize: { type: "integer" } },
      $defs: { SearchParameters: expectedFilters },
    });
    expect(JSON.stringify(reduced)).not.toMatch(/isUnread|is_unread/);
    expect(schema.properties.searchParameters.properties.isUnread).toEqual({ type: "boolean" });
    expect(googleChatToolInputSchema({ config: { sourceTemplateKey: "gmail" } }, "search_messages", schema)).toBe(schema);
  });

  it("replaces upstream unread-search instructions with supported search guidance", () => {
    expect(googleChatToolDescription(chat, "search_messages", "Search unread messages."))
      .toContain("Read/unread filtering is not supported.");
    expect(googleChatToolDescription(chat, "list_messages", "Read history.")).toBe("Read history.");
  });
});
