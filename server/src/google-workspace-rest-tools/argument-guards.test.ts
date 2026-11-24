import { describe, expect, it } from "vitest";
import { googleWorkspaceArgumentRefusal } from "./argument-guards.js";

const schema = {
  type: "object",
  properties: {
    fileId: { type: "string" },
    options: { type: "object", properties: { fields: { type: "string" } } },
    closed: { type: "object", additionalProperties: false, properties: { fields: { type: "string" } } },
  },
};

describe("googleWorkspaceArgumentRefusal", () => {
  it("refuses an unknown top-level argument and names the accepted ones", () => {
    expect(googleWorkspaceArgumentRefusal({ service: "drive", toolName: "get_file_metadata", arguments: { fileId: "f1", fields: "*" }, inputSchema: schema }))
      .toBe("Invalid arguments for get_file_metadata: unknown argument \"fields\". Accepted arguments: fileId, options, closed. Nothing was sent to Google.");
  });

  it("checks a nested object only when its schema closes it", () => {
    expect(googleWorkspaceArgumentRefusal({ service: "drive", toolName: "get_file_metadata", arguments: { fileId: "f1", options: { extra: 1 } }, inputSchema: schema })).toBeNull();
    expect(googleWorkspaceArgumentRefusal({ service: "drive", toolName: "get_file_metadata", arguments: { fileId: "f1", closed: { extra: 1 } }, inputSchema: schema }))
      .toContain("unknown argument \"extra\" in closed.");
  });

  it("leaves a schema that allows more arguments, or lists none, to the server", () => {
    expect(googleWorkspaceArgumentRefusal({ service: "gmail", toolName: "get_message", arguments: { any: 1 }, inputSchema: { type: "object", properties: {}, additionalProperties: true } })).toBeNull();
    expect(googleWorkspaceArgumentRefusal({ service: "gmail", toolName: "get_message", arguments: { any: 1 }, inputSchema: { type: "object" } })).toBeNull();
  });

  it("requires one file ID for Drive, Docs, Sheets and Slides, and leaves Gmail and Calendar IDs alone", () => {
    expect(googleWorkspaceArgumentRefusal({ service: "sheets", toolName: "get_values", arguments: { spreadsheetId: "a b" }, inputSchema: {} }))
      .toContain("spreadsheetId must be one Google file ID");
    expect(googleWorkspaceArgumentRefusal({ service: "calendar", toolName: "get_event", arguments: { eventId: "a b" }, inputSchema: {} })).toBeNull();
  });

  it("refuses Slides and Docs requests outside the closed lists, and requests with more than one kind", () => {
    expect(googleWorkspaceArgumentRefusal({ service: "slides", toolName: "update_presentation",
      arguments: { presentationId: "p1", requests: [{ createVideo: { source: "DRIVE", id: "v1" } }] }, inputSchema: {} }))
      .toContain("a DRIVE video is another file");
    expect(googleWorkspaceArgumentRefusal({ service: "docs", toolName: "update_doc",
      arguments: { documentId: "d1", requests: [{ insertText: {}, deleteContentRange: {} }] }, inputSchema: {} }))
      .toContain("each request names exactly one kind of update");
    expect(googleWorkspaceArgumentRefusal({ service: "docs", toolName: "update_doc",
      arguments: { documentId: "d1", requests: [{ insertText: { text: "Hi", location: { index: 1 } } }] }, inputSchema: {} })).toBeNull();
  });
});
