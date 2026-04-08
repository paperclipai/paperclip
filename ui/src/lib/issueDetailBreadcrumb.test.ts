import { describe, expect, it } from "vitest";
import {
  armIssueDetailInboxQuickArchive,
  createIssueDetailLocationState,
  createIssueDetailPath,
  hasLegacyIssueDetailQuery,
  readIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
  shouldArmIssueDetailInboxQuickArchive,
} from "./issueDetailBreadcrumb";

const sessionStorageMock = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => {
      store.clear();
    },
  };
})();

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { sessionStorage: sessionStorageMock },
});

describe("issueDetailBreadcrumb", () => {
  it("returns clean issue detail paths", () => {
    expect(createIssueDetailPath("PAP-465")).toBe("/issues/PAP-465");
  });

  it("prefers the full breadcrumb from route state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(readIssueDetailBreadcrumb("PAP-465", state, "?from=issues")).toEqual({
      label: "Inbox",
      href: "/inbox/mine",
    });
  });

  it("falls back to the source query param when route state is unavailable", () => {
    expect(readIssueDetailBreadcrumb("PAP-465", null, "?from=inbox")).toEqual({
      label: "Inbox",
      href: "/inbox",
    });
  });

  it("can detect legacy query-based breadcrumb links", () => {
    expect(hasLegacyIssueDetailQuery("?from=inbox&fromHref=%2Finbox%2Fmine")).toBe(true);
    expect(hasLegacyIssueDetailQuery("?q=test")).toBe(false);
  });

  it("restores the exact breadcrumb href from the query fallback", () => {
    expect(
      readIssueDetailBreadcrumb("PAP-465", null, "?from=inbox&fromHref=%2FPAP%2Finbox%2Funread"),
    ).toEqual({
      label: "Inbox",
      href: "/PAP/inbox/unread",
    });
  });

  it("reads hidden breadcrumb context from session storage when route state is unavailable", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
    sessionStorageMock.clear();
    rememberIssueDetailLocationState("PAP-465", state);

    expect(
      readIssueDetailLocationState("PAP-465", null),
    ).toEqual({
      issueDetailBreadcrumb: { label: "Inbox", href: "/inbox/mine" },
      issueDetailSource: "inbox",
      issueDetailInboxQuickArchiveArmed: false,
    });
  });

  it("can arm quick archive only for explicit inbox keyboard entry state", () => {
    const state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");

    expect(shouldArmIssueDetailInboxQuickArchive(state)).toBe(false);
    expect(shouldArmIssueDetailInboxQuickArchive(armIssueDetailInboxQuickArchive(state))).toBe(true);
  });
});
