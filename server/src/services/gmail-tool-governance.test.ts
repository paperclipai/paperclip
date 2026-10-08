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
  it("keeps combined-profile writes and destructive annotations behind their existing risk gates", () => {
    expect(classifyRisk({ name: "docs__update_doc", annotations: { readOnlyHint: true } }, "google-workspace")).toBe("write");
    expect(classifyRisk({ name: "docs__update_doc", annotations: { destructiveHint: true } }, "google-workspace")).toBe("destructive");
    expect(classifyRisk({ name: "docs__read_doc" }, "google-workspace")).toBe("read");
    expect(classifyRisk({ name: "calendar__delete_event" }, "google-workspace")).toBe("destructive");
    expect(classifyRisk({ name: "chat__send_message" }, "google-workspace")).toBe("destructive");
    expect(isGoogleWorkspaceToolAllowed("workspace.all", { name: "gmail__send_message" })).toBe(false);
    expect(isGoogleWorkspaceToolAllowed("workspace.all", { name: "chat__list_memberships" })).toBe(false);
  });

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

  it("keeps Chat search, history, and sending but excludes membership and read-state tools", () => {
    for (const profile of ["chat.read", "chat.write"] as const) {
      for (const name of ["search_conversations", "list_messages", "search_messages"]) {
        expect(isGoogleWorkspaceToolAllowed(profile, { name })).toBe(true);
      }
      for (const name of ["list_memberships", "mark_as_read", "mark_as_unread"]) {
        expect(isGoogleWorkspaceToolAllowed(profile, { name })).toBe(false);
      }
    }
    expect(isGoogleWorkspaceToolAllowed("chat.read", { name: "send_message" })).toBe(false);
    expect(isGoogleWorkspaceToolAllowed("chat.write", { name: "send_message" })).toBe(true);
  });
});
