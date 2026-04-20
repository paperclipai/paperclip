import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { FeedbackTrace } from "@paperclipai/shared";
import { readZipArchive } from "../commands/client/zip.js";
import {
  buildFeedbackTraceQuery,
  registerFeedbackCommands,
  renderFeedbackReport,
  summarizeFeedbackTraces,
  writeFeedbackExportBundle,
} from "../commands/client/feedback.js";

function makeTrace(overrides: Partial<FeedbackTrace> = {}): FeedbackTrace {
  return {
    id: "trace-12345678",
    companyId: "company-123",
    feedbackVoteId: "vote-12345678",
    issueId: "issue-123",
    projectId: "project-123",
    issueIdentifier: "PAP-123",
    issueTitle: "Fix the feedback command",
    authorUserId: "user-123",
    targetType: "issue_comment",
    targetId: "comment-123",
    vote: "down",
    status: "pending",
    destination: "paperclip_labs_feedback_v1",
    exportId: null,
    consentVersion: "feedback-data-sharing-v1",
    schemaVersion: "1",
    bundleVersion: "1",
    payloadVersion: "1",
    payloadDigest: null,
    payloadSnapshot: {
      vote: {
        value: "down",
        reason: "Needed more detail",
      },
    },
    targetSummary: {
      label: "Comment",
      excerpt: "The first answer was too vague.",
      authorAgentId: "agent-123",
      authorUserId: null,
      createdAt: new Date("2026-03-31T12:00:00.000Z"),
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
    },
    redactionSummary: null,
    attemptCount: 0,
    lastAttemptedAt: null,
    exportedAt: null,
    failureReason: null,
    createdAt: new Date("2026-03-31T12:01:00.000Z"),
    updatedAt: new Date("2026-03-31T12:02:00.000Z"),
    ...overrides,
  };
}

describe("registerFeedbackCommands", () => {
  it("registers the top-level feedback commands", () => {
    const program = new Command();

    expect(() => registerFeedbackCommands(program)).not.toThrow();

    const feedback = program.commands.find((command) => command.name() === "feedback");
    expect(feedback).toBeDefined();
    expect(feedback?.commands.map((command) => command.name())).toEqual(["report", "export"]);
    expect(feedback?.commands[0]?.options.filter((option) => option.long === "--company-id")).toHaveLength(1);
  });
});

describe("buildFeedbackTraceQuery", () => {
  it("encodes all supported filters", () => {
    expect(
      buildFeedbackTraceQuery({
        targetType: "issue_comment",
        vote: "down",
        status: "pending",
        projectId: "project-123",
        issueId: "issue-123",
        from: "2026-03-31T00:00:00.000Z",
        to: "2026-03-31T23:59:59.999Z",
        sharedOnly: true,
      }),
    ).toBe(
      "?targetType=issue_comment&vote=down&status=pending&projectId=project-123&issueId=issue-123&from=2026-03-31T00%3A00%3A00.000Z&to=2026-03-31T23%3A59%3A59.999Z&sharedOnly=true&includePayload=true",
    );
  });
});

describe("renderFeedbackReport", () => {
  it("includes summary counts and the optional reason", () => {
    const traces = [
      makeTrace(),
      makeTrace({
        id: "trace-87654321",
        feedbackVoteId: "vote-87654321",
        vote: "up",
        status: "local_only",
        payloadSnapshot: {
          vote: {
            value: "up",
            reason: null,
          },
        },
      }),
    ];

    const report = renderFeedbackReport({
      apiBase: "http://127.0.0.1:3100",
      companyId: "company-123",
      traces,
      summary: summarizeFeedbackTraces(traces),
      includePayloads: false,
    });

    expect(report).toContain("Paperclip Feedback Report");
    expect(report).toContain("thumbs up");
    expect(report).toContain("thumbs down");
    expect(report).toContain("Needed more detail");
  });
});

describe("writeFeedbackExportBundle", () => {
  it("writes votes, traces, a manifest, and a zip archive", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-feedback-export-"));
    const outputDir = path.join(tempDir, "feedback-export");
    const traces = [
      makeTrace(),
      makeTrace({
        id: "trace-abcdef12",
        feedbackVoteId: "vote-abcdef12",
        issueIdentifier: "PAP-124",
        issueId: "issue-124",
        vote: "up",
        status: "local_only",
        payloadSnapshot: {
          vote: {
            value: "up",
            reason: null,
          },
        },
      }),
    ];

    const exported = await writeFeedbackExportBundle({
      apiBase: "http://127.0.0.1:3100",
      companyId: "company-123",
      traces,
      outputDir,
    });

    expect(exported.manifest.summary.total).toBe(2);
    expect(exported.manifest.summary.withReason).toBe(1);

    const manifest = JSON.parse(await readFile(path.join(outputDir, "index.json"), "utf8")) as {
      files: { votes: string[]; traces: string[]; zip: string };
    };
    expect(manifest.files.votes).toHaveLength(2);
    expect(manifest.files.traces).toHaveLength(2);

    const archive = await readFile(exported.zipPath);
    const zip = await readZipArchive(archive);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "index.json",
        `votes/${manifest.files.votes[0]}`,
        `traces/${manifest.files.traces[0]}`,
      ]),
    );
  });
});
