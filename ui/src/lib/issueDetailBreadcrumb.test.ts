import { describe, expect, it } from "vitest";
import {
  armIssueDetailInboxQuickArchive,
  createIssueDetailLocationState,
  createIssueDetailPath,
  readIssueDetailBreadcrumb,
  shouldArmIssueDetailInboxQuickArchive,
} from "./issueDetailBreadcrumb";

describe("issueDetailBreadcrumb", () => {
  it("prefers the full breadcrumb from route state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(readIssueDetailBreadcrumb(state, "?from=issues")).toEqual({
      label: "Inbox",
      href: "/inbox/mine",
    });
  });

  it("falls back to the source query param when route state is unavailable", () => {
    expect(readIssueDetailBreadcrumb(null, "?from=inbox")).toEqual({
      label: "Inbox",
      href: "/inbox",
    });
  });

  it("adds the source query param when building an issue detail path", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(createIssueDetailPath("PAP-465", state)).toBe(
      "/issues/PAP-465?from=inbox&fromHref=%2Finbox%2Fmine",
    );
  });

  it("reuses the current source query param when state has been dropped", () => {
    expect(createIssueDetailPath("PAP-465", null, "?from=issues&fromHref=%2Fissues%3Fq%3Dabc")).toBe(
      "/issues/PAP-465?from=issues&fromHref=%2Fissues%3Fq%3Dabc",
    );
  });

  it("restores the exact breadcrumb href from the query fallback", () => {
    expect(
      readIssueDetailBreadcrumb(null, "?from=inbox&fromHref=%2FPAP%2Finbox%2Funread"),
    ).toEqual({
      label: "Inbox",
      href: "/PAP/inbox/unread",
    });
  });

  it("can arm quick archive only for explicit inbox keyboard entry state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(shouldArmIssueDetailInboxQuickArchive(state)).toBe(false);
    expect(shouldArmIssueDetailInboxQuickArchive(armIssueDetailInboxQuickArchive(state))).toBe(true);
  });
});
