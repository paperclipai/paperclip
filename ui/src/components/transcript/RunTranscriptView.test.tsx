// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../adapters";
import type { ToolRunDecision } from "@paperclipai/shared";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

describe("RunTranscriptView", () => {
  it("keeps running command stdout inside the command fold instead of a standalone stdout block", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:00.000Z",
        name: "command_execution",
        toolUseId: "cmd_1",
        input: { command: "ls -la" },
      },
      {
        kind: "stdout",
        ts: "2026-03-12T00:00:01.000Z",
        text: "file-a\nfile-b",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("renders assistant and thinking content as markdown in compact mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Hello **world**",
            },
            {
              kind: "thinking",
              ts: "2026-03-12T00:00:01.000Z",
              text: "- first\n- second",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("<strong>world</strong>");
    expect(html).toMatch(/<li[^>]*>first<\/li>/);
    expect(html).toMatch(/<li[^>]*>second<\/li>/);
  });

  it("hides saved-session resume skip stderr from nice mode normalization", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Skipping saved session resume for task \"PAP-485\" because wake reason is issue_assigned.",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Working on the task.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Working on the task.",
    });
  });

  it("renders successful result summaries as markdown in nice mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "result",
              ts: "2026-03-12T00:00:02.000Z",
              text: "## Summary\n\n- fixed deploy config\n- posted issue update",
              inputTokens: 10,
              outputTokens: 20,
              cachedTokens: 0,
              costUsd: 0,
              subtype: "success",
              isError: false,
              errors: [],
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toMatch(/<li[^>]*>fixed deploy config<\/li>/);
    expect(html).toMatch(/<li[^>]*>posted issue update<\/li>/);
    expect(html).not.toContain("result");
  });

  it("links tool rows to pending governed action decisions", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const actionRequestId = "22222222-2222-4222-8222-222222222222";
    const decision: ToolRunDecision = {
      invocation: {
        id: invocationId,
        companyId: "company-1",
        idempotencyKey: null,
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        issueId: "issue-1",
        runId: "run-1",
        applicationId: null,
        connectionId: null,
        catalogEntryId: null,
        toolName: "send_email",
        argumentsHash: "hash-1",
        argumentsSummary: { summary: "{\"to\":\"redacted\"}" },
        policyDecision: "require_approval",
        matchedPolicyIds: [],
        approvalState: "pending",
        status: "awaiting_approval",
        upstreamRequestId: null,
        resultHash: null,
        resultSummary: null,
        resultSizeBytes: null,
        resultArtifactId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date("2026-03-12T00:00:00.000Z"),
        updatedAt: new Date("2026-03-12T00:00:00.000Z"),
      },
      actionRequest: {
        id: actionRequestId,
        companyId: "company-1",
        invocationId,
        issueId: "issue-1",
        interactionId: "33333333-3333-4333-8333-333333333333",
        approvalId: null,
        status: "pending",
        canonicalArgumentsHash: "hash-1",
        canonicalArgumentsSummary: { summary: "{\"to\":\"redacted\"}" },
        signedArguments: null,
        previewMarkdown: "Tool: `send_email`",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        decidedByAgentId: null,
        decidedByUserId: null,
        decidedAt: null,
        expiresAt: null,
        resolvedAt: null,
        createdAt: new Date("2026-03-12T00:00:00.000Z"),
        updatedAt: new Date("2026-03-12T00:00:00.000Z"),
      },
      auditEvents: [],
      latestAuditEvent: null,
      decision: "require_approval",
      outcome: "pending",
      reasonCode: "requires_approval_policy",
      denialReason: null,
      pendingAction: {
        actionRequestId,
        issueId: "issue-1",
        interactionId: "33333333-3333-4333-8333-333333333333",
        approvalId: null,
        status: "pending",
        previewMarkdown: "Tool: `send_email`",
      },
    };

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:00.000Z",
              name: "send_email",
              invocationId,
              input: { to: "redacted@example.com" },
            },
          ]}
          toolDecisions={[decision]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Needs approval");
    expect(html).toContain(`Action request ${actionRequestId.slice(0, 8)}`);
  });

  it("windows large raw transcripts instead of rendering every entry at once", () => {
    const entries: TranscriptEntry[] = Array.from({ length: 500 }, (_, index) => ({
      kind: "stdout",
      ts: `2026-03-12T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      text: `line-${index}`,
    }));

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView mode="raw" entries={entries} />
      </ThemeProvider>,
    );

    expect(html).toContain("line-0");
    expect(html).toContain("line-179");
    expect(html).not.toContain("line-250");
    expect(html).not.toContain("line-499");
  });
});
