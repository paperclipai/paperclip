import { describe, expect, it } from "vitest";

import {
  classifyRisk,
  isGmailToolPermanentlyBlocked,
  isGoogleWorkspaceToolAllowed,
} from "./tool-access.js";

describe("Gmail tool governance", () => {
  it("allows reviewed reads and draft creation while keeping delivery and destructive actions blocked", () => {
    expect(isGmailToolPermanentlyBlocked({ name: "search_threads" })).toBe(false);
    expect(isGmailToolPermanentlyBlocked({ name: "get_message" })).toBe(false);
    expect(classifyRisk({ name: "create_draft" }, "gmail")).toBe("write");
    expect(isGmailToolPermanentlyBlocked({ name: "create_draft" })).toBe(false);

    expect(isGmailToolPermanentlyBlocked({ name: "send_message" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "trash_thread" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "mark_as_spam" })).toBe(true);
    expect(isGmailToolPermanentlyBlocked({ name: "update_labels" })).toBe(true);
  });
});

describe("Google Workspace tool governance", () => {
  it("limits each capability profile to its reviewed reads and writes", () => {
    expect(isGoogleWorkspaceToolAllowed("drive.read", { name: "search_files" })).toBe(true);
    expect(isGoogleWorkspaceToolAllowed("drive.read", { name: "create_file" })).toBe(false);
    expect(isGoogleWorkspaceToolAllowed("drive.write", { name: "create_file" })).toBe(true);

    expect(isGoogleWorkspaceToolAllowed("gmail.draft", { name: "create_draft" })).toBe(true);
    expect(isGoogleWorkspaceToolAllowed("gmail.draft", { name: "send_message" })).toBe(false);
    expect(isGoogleWorkspaceToolAllowed("calendar.write", { name: "delete_event" })).toBe(true);
    expect(isGoogleWorkspaceToolAllowed("calendar.write", { name: "publish_calendar" })).toBe(false);
  });

  it("normalizes namespaced provider tool names and denies unknown preview tools", () => {
    expect(isGoogleWorkspaceToolAllowed("docs.read", { name: "google.docs/read_doc" })).toBe(true);
    expect(isGoogleWorkspaceToolAllowed("sheets.write", { name: "sheets.updateValues" })).toBe(true);
    expect(isGoogleWorkspaceToolAllowed("people.read", { name: "delete_contact" })).toBe(false);
  });
});
