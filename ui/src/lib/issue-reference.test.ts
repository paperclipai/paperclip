import { describe, expect, it } from "vitest";
import { parseIssuePathIdFromPath, parseIssueReferenceFromHref } from "./issue-reference";

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("extracts issue ids from full issue URLs", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBe("PAP-1179");
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, issue URLs, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toEqual({
      issuePathId: "PAP-1179",
      href: "/issues/PAP-1179",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });
});
