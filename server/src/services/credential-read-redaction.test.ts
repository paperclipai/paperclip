import { describe, expect, it } from "vitest";
import { createFeedbackRedactionState, sanitizeFeedbackText } from "./feedback-redaction.js";
import { redactStoredSlotLogs } from "./tool-runtime-supervisor.js";
import { toWorkspaceOperation } from "./workspace-operations.js";

const TOKEN = "opaquecompanytokenvalue1234567890abcd";
const FINE_GRAINED = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

describe("historical credential reads", () => {
  it("scrubs tokenized remotes in workspace operation excerpts", () => {
    const operation = toWorkspaceOperation({
      id: "op-1",
      companyId: "company-1",
      executionWorkspaceId: null,
      heartbeatRunId: null,
      issueId: null,
      phase: "exec",
      command: `clone https://${TOKEN}@github.com/org/repo.git`,
      cwd: null,
      status: "failed",
      exitCode: 128,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: `https://${TOKEN}@github.com/org/repo.git`,
      stderrExcerpt: `https://${FINE_GRAINED}@github.com/org/repo.git`,
      metadata: null,
      startedAt: new Date("2026-09-24T00:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-09-24T00:00:00.000Z"),
      updatedAt: new Date("2026-09-24T00:00:00.000Z"),
    });

    expect(operation.stdoutExcerpt).not.toContain(TOKEN);
    expect(operation.stderrExcerpt).not.toContain(FINE_GRAINED);
    expect(operation.command).not.toContain(TOKEN);
    expect(operation.stdoutExcerpt).toContain("https://***REDACTED***@github.com/org/repo.git");
  });

  it("scrubs tokenized remotes already stored on a tool-runtime slot", () => {
    const metadata = redactStoredSlotLogs({
      logs: [
        { stream: "stderr", line: `https://${TOKEN}@github.com/org/repo.git`, at: "2026-09-24T00:00:00.000Z" },
        { stream: "stdout", line: "plain line", at: "2026-09-24T00:00:00.000Z" },
      ],
    });
    const logs = metadata.logs as Array<{ line: string }>;
    expect(logs[0]?.line).not.toContain(TOKEN);
    expect(logs[0]?.line).toContain("https://***REDACTED***@github.com/org/repo.git");
    expect(logs[1]?.line).toBe("plain line");
  });

  it("scrubs tokenized remotes in feedback run-log text", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      [
        `https://${TOKEN}@github.com/org/repo.git`,
        FINE_GRAINED,
        "Authorization: token opaquecompanytokenvalue1234567890abcd",
        "To https://github.com/org/repo.git",
      ].join("\n"),
      state,
      "bundle.paperclipRun.log",
      20_000,
    );

    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(FINE_GRAINED);
    expect(output).toContain("https://***REDACTED***@github.com/org/repo.git");
    expect(output).toContain("https://github.com/org/repo.git");
    expect(state.counts.get("transport_credential")).toBeGreaterThan(0);
  });
});
