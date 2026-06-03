// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildSystemNoticeProps, mapCommentMetadataToSystemNoticeSections } from "./system-notice-comment";

describe("mapCommentMetadataToSystemNoticeSections", () => {
  it("maps server metadata row types to SystemNotice rows", () => {
    const sections = mapCommentMetadataToSystemNoticeSections(
      {
        version: 1,
        sections: [
          {
            title: "Required action",
            rows: [
              { type: "issue_link", label: "Source issue", issueId: "i1", identifier: "PAP-3440", title: "Recovery" },
              { type: "agent_link", label: "Assignee", agentId: "agent-1", name: "CodexCoder" },
              { type: "key_value", label: "Status before", value: "in_progress" },
              { type: "code", label: "Cause code", code: "missing_disposition" },
              { type: "text", label: "Notes", text: "Pick a disposition." },
              { type: "run_link", label: "Source run", runId: "9cdba892-c7ca-4d93-8604-4843873b127c", title: "succeeded" },
            ],
          },
        ],
      },
      { runAgentId: "agent-1" },
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Required action");

    const rows = sections[0]!.rows;
    expect(rows).toEqual([
      {
        kind: "issue",
        label: "Source issue",
        identifier: "PAP-3440",
        href: "/issues/PAP-3440",
        title: "Recovery",
      },
      { kind: "agent", label: "Assignee", name: "CodexCoder", href: "/agents/agent-1" },
      { kind: "text", label: "Status before", value: "in_progress" },
      { kind: "code", label: "Cause code", value: "missing_disposition" },
      { kind: "text", label: "Notes", value: "Pick a disposition." },
      {
        kind: "run",
        label: "Source run",
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/agents/agent-1/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
    ]);
  });

  it("omits run href when no runAgentId is available", () => {
    const sections = mapCommentMetadataToSystemNoticeSections(
      {
        version: 1,
        sections: [
          {
            rows: [
              { type: "run_link", label: "Run", runId: "abc12345" },
            ],
          },
        ],
      },
      {},
    );

    expect(sections[0]?.rows[0]).toEqual({
      kind: "run",
      label: "Run",
      runId: "abc12345",
      href: undefined,
      status: undefined,
    });
  });

  it("returns an empty array for null metadata", () => {
    expect(mapCommentMetadataToSystemNoticeSections(null)).toEqual([]);
    expect(mapCommentMetadataToSystemNoticeSections(undefined)).toEqual([]);
  });
});

describe("buildSystemNoticeProps", () => {
  it("derives tone, label, and metadata from a system_notice presentation", () => {
    const props = buildSystemNoticeProps({
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing disposition",
        detailsDefaultOpen: false,
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Required",
            rows: [{ type: "key_value", label: "Status", value: "in_progress" }],
          },
        ],
      },
      body: "Body text",
      runAgentId: "agent-1",
    });

    expect(props.tone).toBe("warning");
    expect(props.label).toBe("Missing disposition");
    expect(props.detailsDefaultOpen).toBe(false);
    expect(props.metadata?.[0]?.rows[0]).toEqual({
      kind: "text",
      label: "Status",
      value: "in_progress",
    });
  });

  it("falls back to neutral tone with default label when presentation is null", () => {
    const props = buildSystemNoticeProps({
      presentation: null,
      metadata: null,
      body: "Hello",
    });

    expect(props.tone).toBe("neutral");
    expect(props.label).toBe("System notice");
    expect(props.metadata).toBeUndefined();
  });

  it("uses the danger default label when presentation lacks a title", () => {
    const props = buildSystemNoticeProps({
      presentation: {
        kind: "system_notice",
        tone: "danger",
        title: null,
        detailsDefaultOpen: true,
      },
      metadata: null,
      body: "boom",
    });

    expect(props.label).toBe("System alert");
    expect(props.detailsDefaultOpen).toBe(true);
  });
});
