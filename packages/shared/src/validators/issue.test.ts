import { describe, expect, it } from "vitest";
import { MAX_ISSUE_REQUEST_DEPTH } from "../index.js";
import {
  addIssueCommentSchema,
  createIssueSchema,
  issueDispositionEvidenceRefSchema,
  issueDispositionFindingBundleSchema,
  issueDispositionProjectionSchema,
  issueDispositionRecordSchema,
  respondIssueThreadInteractionSchema,
  suggestedTaskDraftSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";
import { createAgentSchema } from "./agent.js";
import type { IssueCommentMetadata } from "../types/issue.js";

describe("issue validators", () => {
  it("passes real line breaks through unchanged", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "Line 1\n\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("accepts null and omitted optional multiline issue fields", () => {
    expect(createIssueSchema.parse({ title: "Follow up PR", description: null }).description)
      .toBeNull();
    expect(createIssueSchema.parse({ title: "Follow up PR" }).description)
      .toBeUndefined();
    expect(updateIssueSchema.parse({ comment: undefined }).comment)
      .toBeUndefined();
  });

  it("normalizes JSON-escaped line breaks in issue descriptions", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "PR: https://example.com/pr/1\\n\\nShip the follow-up.",
    });

    expect(parsed.description).toBe("PR: https://example.com/pr/1\n\nShip the follow-up.");
  });

  it("normalizes escaped line breaks in issue update comments", () => {
    const parsed = updateIssueSchema.parse({
      comment: "Done\\n\\n- Verified the route",
    });

    expect(parsed.comment).toBe("Done\n\n- Verified the route");
  });

  it("normalizes escaped line breaks in issue comment bodies", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Progress update\\r\\n\\r\\nNext action.",
    });

    expect(parsed.body).toBe("Progress update\n\nNext action.");
  });

  it("accepts structured issue comment presentation and metadata", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Paperclip needs a disposition before this issue can continue.",
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Needs disposition",
      },
      metadata: {
        version: 1,
        sourceRunId: "11111111-1111-4111-8111-111111111111",
        sections: [
          {
            title: "Evidence",
            rows: [
              { type: "key_value", label: "Cause", value: "successful_run_missing_state" },
              { type: "issue_link", label: "Source issue", identifier: "PAP-3440" },
              { type: "run_link", label: "Run", runId: "11111111-1111-4111-8111-111111111111" },
            ],
          },
        ],
      },
    });

    expect(parsed.presentation?.detailsDefaultOpen).toBe(false);
    expect(parsed.metadata?.sourceRunId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.metadata?.sections[0]?.rows).toHaveLength(3);
  });

  it("accepts canonical disposition issue metadata rows", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Disposition update",
      metadata: {
        version: 1,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "needs_review",
                reason: "Review path requested",
                evidenceRefs: [
                  { kind: "run", id: "11111111-1111-4111-8111-111111111111" },
                  { kind: "event", id: "22222222-2222-4222-8222-222222222222" },
                ],
                idempotencyKey: "disposition:issue-1:run-1:needs_review",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.metadata?.sections[0]?.rows[0].type).toBe("disposition");
  });

  it("rejects disposition metadata rows when idempotency value mismatches row value", () => {
    const parsed = addIssueCommentSchema.safeParse({
      body: "Disposition update",
      metadata: {
        version: 1,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "needs_review",
                idempotencyKey: "disposition:issue-1:run-1:done",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts disposition rows with type-exposed findingBundles and finalDisposition fields", () => {
    const sourceRunId = "11111111-1111-4111-8111-111111111111";
    const metadata: IssueCommentMetadata = {
      version: 1,
      sourceRunId,
      sections: [
        {
          rows: [
            {
              type: "disposition",
              value: "done",
              evidenceRefs: [{ kind: "run", id: sourceRunId }],
              idempotencyKey: `disposition:issue-1:${sourceRunId}:done`,
              findingBundles: [
                {
                  kind: "qa",
                  summary: "QA passed",
                  findings: [
                    {
                      id: "01HZY6Z8J8QZ1B7V6R0YX6T3AB",
                      severity: "minor",
                      area: "contract",
                      summary: "No blocking issues",
                      acceptance: "No action required",
                      evidenceRefs: [{ kind: "run", id: sourceRunId }],
                    },
                  ],
                },
              ],
              finalDisposition: {
                value: "done",
                setAt: "2026-05-16T00:00:00.000Z",
                setByActor: { type: "agent", id: "22222222-2222-4222-8222-222222222222" },
                sourceRunId,
                evidenceRefs: [{ kind: "run", id: sourceRunId }],
                idempotencyKey: `disposition:issue-1:${sourceRunId}:done`,
              },
            },
          ],
        },
      ],
    };

    const parsed = addIssueCommentSchema.parse({
      body: "Disposition with full evidence",
      metadata,
    });

    const row = parsed.metadata?.sections[0]?.rows[0];
    expect(row?.type).toBe("disposition");
    if (row?.type === "disposition") {
      expect(row.findingBundles?.[0]?.kind).toBe("qa");
      expect(row.finalDisposition?.value).toBe("done");
    }
  });

  it("rejects disposition rows when metadata.sourceRunId does not match idempotencyKey sourceRunId", () => {
    const metadataRunId = "11111111-1111-4111-8111-111111111111";
    const otherRunId = "22222222-2222-4222-8222-222222222222";
    const parsed = addIssueCommentSchema.safeParse({
      body: "Disposition with mismatched provenance",
      metadata: {
        version: 1,
        sourceRunId: metadataRunId,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "done",
                idempotencyKey: `disposition:issue-1:${otherRunId}:done`,
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects disposition rows when metadata.sourceRunId does not match finalDisposition.sourceRunId", () => {
    const metadataRunId = "11111111-1111-4111-8111-111111111111";
    const otherRunId = "22222222-2222-4222-8222-222222222222";
    const parsed = addIssueCommentSchema.safeParse({
      body: "Disposition with mismatched final disposition run",
      metadata: {
        version: 1,
        sourceRunId: metadataRunId,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "done",
                idempotencyKey: `disposition:issue-1:${metadataRunId}:done`,
                finalDisposition: {
                  value: "done",
                  setAt: "2026-05-16T00:00:00.000Z",
                  setByActor: { type: "agent", id: "33333333-3333-4333-8333-333333333333" },
                  sourceRunId: otherRunId,
                  evidenceRefs: [{ kind: "run", id: otherRunId }],
                  idempotencyKey: `disposition:issue-1:${metadataRunId}:done`,
                },
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects disposition rows when finalDisposition.value does not match row value", () => {
    const sourceRunId = "11111111-1111-4111-8111-111111111111";
    const parsed = addIssueCommentSchema.safeParse({
      body: "Disposition with conflicting final disposition value",
      metadata: {
        version: 1,
        sourceRunId,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "done",
                idempotencyKey: `disposition:issue-1:${sourceRunId}:done`,
                finalDisposition: {
                  value: "blocked",
                  setAt: "2026-05-16T00:00:00.000Z",
                  setByActor: { type: "agent", id: "44444444-4444-4444-8444-444444444444" },
                  sourceRunId,
                  evidenceRefs: [{ kind: "run", id: sourceRunId }],
                  idempotencyKey: `disposition:issue-1:${sourceRunId}:blocked`,
                },
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects disposition rows when finalDisposition.idempotencyKey differs from row idempotencyKey", () => {
    const sourceRunId = "11111111-1111-4111-8111-111111111111";
    const otherRunId = "22222222-2222-4222-8222-222222222222";
    const parsed = addIssueCommentSchema.safeParse({
      body: "Disposition with mismatched idempotency keys",
      metadata: {
        version: 1,
        sections: [
          {
            rows: [
              {
                type: "disposition",
                value: "done",
                idempotencyKey: `disposition:issue-1:${sourceRunId}:done`,
                finalDisposition: {
                  value: "done",
                  setAt: "2026-05-16T00:00:00.000Z",
                  setByActor: { type: "agent", id: "55555555-5555-4555-8555-555555555555" },
                  evidenceRefs: [{ kind: "run", id: sourceRunId }],
                  idempotencyKey: `disposition:issue-1:${otherRunId}:done`,
                },
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("validates issue disposition evidence refs independently", () => {
    expect(issueDispositionEvidenceRefSchema.safeParse({
      kind: "run",
      id: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(true);
    expect(issueDispositionEvidenceRefSchema.safeParse({
      kind: "document",
      id: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
    }).success).toBe(true);
    expect(issueDispositionEvidenceRefSchema.safeParse({
      kind: "artifact",
      id: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });

  it("validates issue final disposition record schema and external evidence bounds", () => {
    const baseRecord = {
      value: "not_actionable",
      setAt: "2026-05-16T00:00:00.000Z",
      setByActor: { type: "agent", id: "11111111-1111-4111-8111-111111111111" },
      reason: "Out of scope",
      evidenceRefs: [{ kind: "comment", id: "22222222-2222-4222-8222-222222222222" }],
      idempotencyKey: "disposition:issue-1:run-1:not_actionable",
    } as const;

    expect(issueDispositionRecordSchema.safeParse(baseRecord).success).toBe(true);
    expect(issueDispositionRecordSchema.safeParse({
      ...baseRecord,
      value: "done",
      idempotencyKey: "disposition:issue-1:run-1:not_actionable",
    }).success).toBe(false);
    expect(issueDispositionRecordSchema.safeParse({
      ...baseRecord,
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "disposition:issue-1:22222222-2222-4222-8222-222222222222:not_actionable",
    }).success).toBe(false);
    expect(issueDispositionRecordSchema.safeParse({
      ...baseRecord,
      value: "done",
      evidenceRefs: [{ kind: "external", uri: "https://example.com/evidence" }],
    }).success).toBe(false);
  });

  it("validates issue finding bundle schema", () => {
    expect(issueDispositionFindingBundleSchema.safeParse({
      kind: "review",
      summary: "ok",
      findings: [{
        id: "01HZY6Z8J8QZ1B7V6R0YX6T3AB",
        area: "runtime",
        summary: "desc",
        acceptance: "fix",
        severity: "major",
        evidenceRefs: [{ kind: "comment", id: "11111111-1111-4111-8111-111111111111" }],
      }],
    }).success).toBe(true);
    expect(issueDispositionFindingBundleSchema.safeParse({
      kind: "review",
      summary: "ok",
      findings: [{ id: "F", area: "runtime", summary: "desc", acceptance: "fix", severity: "fatal", evidenceRefs: [] }],
    }).success).toBe(false);
  });

  it("validates LET-247 issue disposition projection schema", () => {
    expect(issueDispositionProjectionSchema.parse({
      finalDisposition: "needs_review",
      finalDispositionSource: "qa_verdict",
      usefulOutputClass: "useful_output",
      canonicalBlockerGraph: {
        canonicalBlockerId: "11111111-1111-4111-8111-111111111111",
        coveredBlockerIds: ["22222222-2222-4222-8222-222222222222"],
        staleBlockerIds: [],
        supersededBlockerIds: [],
      },
      nextGate: {
        kind: "review",
        ownerAgentId: "33333333-3333-4333-8333-333333333333",
        action: "Reviewer verdict required",
        evidenceRequired: ["QA PASS"],
      },
      evidenceChain: [{
        id: "chain-1",
        source: "qa_verdict",
        evidence: { kind: "comment", id: "44444444-4444-4444-8444-444444444444" },
        gateDriving: true,
      }],
      reviewVerdict: "pending",
      qaVerdict: "pass",
      recoveryDedupKey: "disposition:issue:qa",
      projectionFreshness: {
        generatedAt: "2026-05-16T00:00:00.000Z",
        sourceEventCursor: "evt-1",
        staleMs: 0,
        rebuildState: "fresh",
      },
    }).nextGate.kind).toBe("review");
  });

  it("rejects arbitrary issue comment metadata", () => {
    const parsed = addIssueCommentSchema.safeParse({
      body: "Hidden details",
      metadata: {
        version: 1,
        transcript: "raw log dump",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("normalizes escaped line breaks in generated task drafts", () => {
    const parsed = suggestedTaskDraftSchema.parse({
      clientKey: "task-1",
      title: "Follow up",
      description: "Line 1\\n\\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("normalizes escaped line breaks in thread summaries and documents", () => {
    const response = respondIssueThreadInteractionSchema.parse({
      answers: [],
      summaryMarkdown: "Summary\\n\\nNext action",
    });
    const document = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(response.summaryMarkdown).toBe("Summary\n\nNext action");
    expect(document.body).toBe("# Plan\n\nShip it");
  });

  it("clamps oversized requestDepth values on create", () => {
    const parsed = createIssueSchema.parse({
      title: "Clamp request depth",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 500,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("defaults omitted create status to todo when an assignee is present", () => {
    expect(createIssueSchema.parse({
      title: "Assigned work",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    }).status).toBe("todo");
    expect(createIssueSchema.parse({ title: "Unassigned work" }).status).toBe("backlog");
    expect(createIssueSchema.parse({
      title: "Deliberately parked",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      status: "backlog",
    }).status).toBe("backlog");
  });

  it("defaults issue work mode to standard and accepts planning", () => {
    expect(createIssueSchema.parse({ title: "Plan first" }).workMode).toBe("standard");
    expect(createIssueSchema.parse({ title: "Plan first", workMode: "planning" }).workMode).toBe("planning");
    expect(updateIssueSchema.parse({ workMode: "planning" }).workMode).toBe("planning");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "planning-child",
      title: "Plan child",
      workMode: "planning",
    }).workMode).toBe("planning");
  });

  it("rejects unknown issue work modes", () => {
    expect(createIssueSchema.safeParse({ title: "Plan first", workMode: "normal" }).success).toBe(false);
    expect(suggestedTaskDraftSchema.safeParse({
      clientKey: "bad-child",
      title: "Bad child",
      workMode: "analysis",
    }).success).toBe(false);
  });

  it("clamps oversized requestDepth values on update", () => {
    const parsed = updateIssueSchema.parse({
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 1,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("accepts the cheap model profile in issue assignee adapter overrides", () => {
    const parsed = createIssueSchema.parse({
      title: "Run a cheap heartbeat",
      assigneeAdapterOverrides: {
        modelProfile: "cheap",
      },
    });

    expect(parsed.assigneeAdapterOverrides?.modelProfile).toBe("cheap");
  });

  it("rejects unknown issue model profile keys", () => {
    const parsed = updateIssueSchema.safeParse({
      assigneeAdapterOverrides: {
        modelProfile: "fast",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("validates agent runtime cheap model profile config without rejecting other runtime fields", () => {
    const parsed = createAgentSchema.parse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        heartbeat: { enabled: true },
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Cheap Codex",
            adapterConfig: {
              model: "gpt-5.3-codex-spark",
            },
          },
        },
      },
    });

    expect(parsed.runtimeConfig.modelProfiles?.cheap?.adapterConfig).toEqual({
      model: "gpt-5.3-codex-spark",
    });
    expect(parsed.runtimeConfig.heartbeat).toEqual({ enabled: true });
  });

  it("validates cheap model profile env bindings like top-level adapter config", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              env: {
                API_TOKEN: 123,
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown agent runtime model profile keys", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          fast: {
            adapterConfig: {
              model: "gpt-5-mini",
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
