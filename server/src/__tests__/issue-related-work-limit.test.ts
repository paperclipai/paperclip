import { describe, expect, it } from "vitest";
import type { IssueReferenceSource, IssueRelatedWorkItem } from "@paperclipai/shared";
import {
  ISSUE_RELATED_WORK_MAX_ITEMS,
  ISSUE_RELATED_WORK_MAX_SOURCES,
  limitIssueRelatedWork,
} from "../services/issue-references.js";

function source(index: number): IssueReferenceSource {
  return {
    kind: "comment",
    sourceRecordId: `comment-${index}`,
    label: "comment",
    matchedText: `PAP-${index}`,
  };
}

function item(index: number, sourceCount: number): IssueRelatedWorkItem {
  return {
    issue: {
      id: `issue-${index}`,
      identifier: `PAP-${index}`,
      title: `Issue ${index}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    mentionCount: sourceCount,
    sources: Array.from({ length: sourceCount }, (_, sourceIndex) => source(sourceIndex)),
  };
}

describe("limitIssueRelatedWork", () => {
  it("returns small summaries unchanged with totals and truncated=false", () => {
    const summary = { outbound: [item(1, 2)], inbound: [item(2, 1), item(3, 3)] };

    const limited = limitIssueRelatedWork(summary);

    expect(limited).toEqual({
      outbound: summary.outbound,
      inbound: summary.inbound,
      outboundTotal: 1,
      inboundTotal: 2,
      truncated: false,
    });
  });

  it("caps items per direction, keeps their order, and reports the real totals", () => {
    const outbound = Array.from({ length: 120 }, (_, index) => item(index, 1));
    const inbound = Array.from({ length: 51 }, (_, index) => item(1000 + index, 1));

    const limited = limitIssueRelatedWork({ outbound, inbound });

    expect(ISSUE_RELATED_WORK_MAX_ITEMS).toBe(50);
    expect(limited.outbound).toHaveLength(50);
    expect(limited.inbound).toHaveLength(50);
    expect(limited.outbound.map((entry) => entry.issue.id)).toEqual(outbound.slice(0, 50).map((entry) => entry.issue.id));
    expect(limited.outboundTotal).toBe(120);
    expect(limited.inboundTotal).toBe(51);
    expect(limited.truncated).toBe(true);
  });

  it("caps sources per item but keeps the real mention count", () => {
    const heavy = item(7, 40);

    const limited = limitIssueRelatedWork({ outbound: [heavy], inbound: [] });

    expect(ISSUE_RELATED_WORK_MAX_SOURCES).toBe(5);
    expect(limited.outbound[0]?.sources).toEqual(heavy.sources.slice(0, 5));
    expect(limited.outbound[0]?.mentionCount).toBe(40);
    expect(heavy.sources).toHaveLength(40);
    expect(limited.truncated).toBe(true);
  });

  it("does not flag exactly-at-limit summaries as truncated", () => {
    const outbound = Array.from({ length: 50 }, (_, index) => item(index, 5));

    const limited = limitIssueRelatedWork({ outbound, inbound: [] });

    expect(limited.outbound).toHaveLength(50);
    expect(limited.truncated).toBe(false);
  });

  it("honours custom limits", () => {
    const limited = limitIssueRelatedWork(
      { outbound: [item(1, 3), item(2, 1)], inbound: [] },
      1,
      2,
    );

    expect(limited.outbound).toHaveLength(1);
    expect(limited.outbound[0]?.sources).toHaveLength(2);
    expect(limited.outboundTotal).toBe(2);
    expect(limited.truncated).toBe(true);
  });

  it("passes through redacted items without a sources array", () => {
    const locked = { issue: { id: "locked-1", locked: true } };
    const limited = limitIssueRelatedWork({ outbound: [locked], inbound: [] }, 50, 1);

    expect(limited.outbound).toEqual([locked]);
    expect(limited.truncated).toBe(false);
  });
});
