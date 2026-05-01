import { describe, expect, it } from "vitest";
import {
  approvalUrl,
  buildApprovalMessage,
  buildCommentMessage,
  buildIssueAssignedMessage,
  buildMorningDigest,
  buildRunFailedMessage,
  escapeMd,
  issueUrl,
  truncate,
} from "./format.js";

describe("escapeMd", () => {
  it("escapes the full MarkdownV2 reserved set", () => {
    const reserved = "_*[]()~`>#+=|{}.!\\-";
    const out = escapeMd(reserved);
    // Each reserved char gets a single leading backslash → output is exactly 2x length.
    expect(out.length).toBe(reserved.length * 2);
    expect(out.startsWith("\\_")).toBe(true);
    expect(out).toContain("\\.");
    expect(out).toContain("\\!");
  });

  it("leaves plain ASCII alone", () => {
    expect(escapeMd("Hello world 123")).toBe("Hello world 123");
  });

  it("leaves Unicode alone", () => {
    expect(escapeMd("Привет 🛂")).toBe("Привет 🛂");
  });
});

describe("truncate", () => {
  it("returns input as-is when under the limit", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("appends an ellipsis when over the limit", () => {
    const out = truncate("a".repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("uses the default limit of 280 chars", () => {
    expect(truncate("a".repeat(300)).length).toBe(280);
  });
});

describe("issueUrl", () => {
  it("strips trailing slashes from the base URL", () => {
    expect(issueUrl("http://localhost:3100/", "abc")).toBe(
      "http://localhost:3100/issues/abc",
    );
    expect(issueUrl("http://localhost:3100///", "abc")).toBe(
      "http://localhost:3100/issues/abc",
    );
  });

  it("URL-encodes the id segment", () => {
    expect(issueUrl("http://x", "ABC 12")).toBe("http://x/issues/ABC%2012");
  });
});

describe("approvalUrl", () => {
  it("builds a plain dashboard link without query parameters", () => {
    expect(approvalUrl("http://x", "ap-1")).toBe("http://x/approvals/ap-1");
  });
});

describe("buildApprovalMessage", () => {
  it("renders title, requester, and reason on separate lines with one button", () => {
    const result = buildApprovalMessage({
      baseUrl: "http://x",
      approvalId: "ap-1",
      title: "Hire QA Engineer",
      reason: "Need a tester for the new flow",
      requestedBy: "PS Lead",
    });
    expect(result.text).toContain("🛂 Approval needed");
    expect(result.text).toContain("Hire QA Engineer");
    expect(result.text).toContain("PS Lead");
    expect(result.text).toContain("Need a tester for the new flow");
    expect(result.keyboard).toHaveLength(1);
    expect(result.keyboard[0]).toHaveLength(1);
    expect(result.keyboard[0][0]).toMatchObject({
      text: "Decide approval →",
      url: "http://x/approvals/ap-1",
    });
  });

  it("omits optional fields without crashing", () => {
    const result = buildApprovalMessage({
      baseUrl: "http://x",
      approvalId: "ap-2",
      title: "Approve",
    });
    expect(result.text).toContain("Approve");
    expect(result.text).not.toContain("Requested by");
  });
});

describe("buildIssueAssignedMessage", () => {
  it("uses the UUID for the deep link, not the human identifier", () => {
    const result = buildIssueAssignedMessage({
      baseUrl: "http://x",
      identifier: "ABC-12",
      issueId: "abc-uuid",
      title: "Refactor adapter",
    });
    expect(result.keyboard[0][0]).toMatchObject({
      url: "http://x/issues/abc-uuid",
    });
    // The human identifier still appears in the body.
    expect(result.text).toContain("ABC\\-12");
  });

  it("falls back to identifier when no UUID is provided", () => {
    const result = buildIssueAssignedMessage({
      baseUrl: "http://x",
      identifier: "ABC-12",
      title: "Refactor adapter",
    });
    expect(result.keyboard[0][0]).toMatchObject({
      url: "http://x/issues/ABC-12",
    });
  });
});

describe("buildCommentMessage", () => {
  it("escapes markdown in author and body", () => {
    const result = buildCommentMessage({
      baseUrl: "http://x",
      identifier: "ABC-12",
      issueTitle: "Refactor",
      authorName: "QA*Bot",
      body: "Found a bug — fix it_now.",
    });
    expect(result.text).toContain("QA\\*Bot");
    expect(result.text).toContain("\\_now");
  });
});

describe("buildRunFailedMessage", () => {
  it("renders both Open issue and Open agent buttons when both ids are present", () => {
    const result = buildRunFailedMessage({
      baseUrl: "http://x",
      agentId: "agent-uuid",
      agentName: "QA",
      identifier: "ABC-12",
      issueId: "issue-uuid",
      reason: "timeout",
    });
    expect(result.keyboard).toHaveLength(2);
    expect(result.keyboard[0][0]).toMatchObject({ url: "http://x/issues/issue-uuid" });
    expect(result.keyboard[1][0]).toMatchObject({ url: "http://x/agents/agent-uuid" });
  });

  it("omits both buttons when no ids are present", () => {
    const result = buildRunFailedMessage({
      baseUrl: "http://x",
      agentName: "QA",
      reason: "timeout",
    });
    expect(result.keyboard).toHaveLength(0);
  });
});

describe("buildMorningDigest", () => {
  it("renders empty hints for empty sections", () => {
    const result = buildMorningDigest({
      date: "2026-05-01",
      doneYesterday: [],
      inProgress: [],
      todo: [],
    });
    expect(result.text).toContain("2026\\-05\\-01");
    expect(result.text).toContain("Nothing closed yesterday");
    expect(result.text).toContain("No work in flight");
    expect(result.text).toContain("Inbox is clear");
    expect(result.keyboard).toHaveLength(0);
  });

  it("truncates long lists with a +N more hint", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      identifier: `T-${i}`,
      title: `Task ${i}`,
      status: "todo",
    }));
    const result = buildMorningDigest({
      date: "2026-05-01",
      doneYesterday: [],
      inProgress: [],
      todo: items,
      maxPerSection: 3,
    });
    expect(result.text).toContain("T\\-0");
    expect(result.text).toContain("T\\-2");
    expect(result.text).not.toContain("T\\-5");
    expect(result.text).toContain("\\+7 more");
  });

  it("respects custom maxPerSection", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      identifier: `X-${i}`,
      title: "x",
      status: "done",
    }));
    const result = buildMorningDigest({
      date: "2026-05-01",
      doneYesterday: items,
      inProgress: [],
      todo: [],
      maxPerSection: 2,
    });
    expect(result.text).toContain("\\+2 more");
  });
});
