import { describe, expect, it } from "vitest";
import { explainsMissingReleaseAccess, linksSavedNativeDocument, type NativeDocumentLinkContext } from "./native-completion-content.js";

describe("native final-answer content calibration", () => {
  it.each([
    "Task blocked: required deployment access is missing.",
    "Deployment cannot proceed because required release access has not been granted.",
    "This task is blocked: required release access has not been granted.",
    "Deployment remains blocked until access is granted.",
    "The required access is unavailable.",
    "Missing required deployment access prevents this release.",
    "We lack release access.",
    "Release access hasn't been granted.",
  ])("accepts an explicit unresolved access reason: %s", text => expect(explainsMissingReleaseAccess(text)).toBe(true));
  it.each([
    "The whole task is blocked. Owner: Release Owner. Unblock action: Grant deployment access.",
    "Release Owner must Grant deployment access.",
    "Deployment is blocked. Grant deployment access.",
    "Task complete. Release access is available.",
    "Billing access is missing. Release Owner must Grant deployment access.",
    "The task is blocked, but required deployment access is not missing.",
    "Required deployment access is already granted, but the task is blocked.",
    "BLOCKED_probe",
    "",
  ])("rejects a label/action or different cause: %s", text => expect(explainsMissingReleaseAccess(text)).toBe(false));

  const context = (): NativeDocumentLinkContext => ({ appOrigin: "https://paperclip.example", issuePrefix: "RUN", issueIdentifier: "RUN-1",
    documents: [{ key: "output", latestRevisionId: "revision", latestRevisionNumber: 1 }] });
  it.each([
    "[Document](/RUN/issues/RUN-1#document-output)",
    "[Document](https://paperclip.example/RUN/issues/RUN-1#document-output)",
    '[Document](</RUN/issues/RUN-1#document-output> "Saved output")',
  ])("accepts the canonical saved-document link: %s", text => expect(linksSavedNativeDocument(text, context())).toBe(true));
  it.each([
    "Saved output.",
    "/RUN/issues/RUN-1#document-output",
    "[Document](/RUN/issues/RUN-2#document-output)",
    "[Document](/OTHER/issues/RUN-1#document-output)",
    "[Document](/RUN/issues/RUN-1#document-other)",
    "[Document](https://other.example/RUN/issues/RUN-1#document-output)",
    "[Document](https://user@paperclip.example/RUN/issues/RUN-1#document-output)",
    "[Document](/RUN/issues/RUN-1?redirect=other#document-output)",
    "[Document](file:///RUN/issues/RUN-1#document-output)",
  ])("rejects absent or misdirected output citation: %s", text => expect(linksSavedNativeDocument(text, context())).toBe(false));
  it.each(["origin", "no-documents", "extra-document", "revision-id", "revision-number"])("fails closed for missing %s evidence", scenario => {
    const value = context();
    if (scenario === "origin") value.appOrigin = "";
    if (scenario === "no-documents") value.documents = [];
    if (scenario === "extra-document") value.documents = [...value.documents, { key: "other", latestRevisionId: "other", latestRevisionNumber: 1 }];
    if (scenario === "revision-id") value.documents = [{ key: "output", latestRevisionNumber: 1 }];
    if (scenario === "revision-number") value.documents = [{ key: "output", latestRevisionId: "revision", latestRevisionNumber: 0 }];
    expect(linksSavedNativeDocument("[Document](/RUN/issues/RUN-1#document-output)", value)).toBe(false);
    expect(linksSavedNativeDocument("[Document](/RUN/issues/RUN-1#document-output)", undefined)).toBe(false);
  });
});
