import { describe, expect, it } from "vitest";
import { MAX_ISSUE_REQUEST_DEPTH } from "../index.js";
import {
  addIssueCommentSchema,
  createIssueSchema,
  respondIssueThreadInteractionSchema,
  suggestedTaskDraftSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";
import { createAgentSchema } from "./agent.js";

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
