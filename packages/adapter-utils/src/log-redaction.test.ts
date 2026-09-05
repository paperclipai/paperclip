import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";
import { redactTranscriptEntryPaths } from "./log-redaction.js";
import type { TranscriptEntry } from "./types.js";

const FINE_GRAINED_PAT = `github_pat_${"1".repeat(22)}_${"a".repeat(59)}`;
const CLASSIC_PAT = `ghp_${"b".repeat(36)}`;
const REMOTE_LINE = `origin\thttps://x-access-token:${FINE_GRAINED_PAT}@github.com/acme/widgets.git (fetch)`;

function toolResult(content: string): TranscriptEntry {
  return { kind: "tool_result", ts: "2026-01-01T00:00:00.000Z", toolUseId: "u1", content, isError: false };
}

function stdout(text: string): TranscriptEntry {
  return { kind: "stdout", ts: "2026-01-01T00:00:00.000Z", text };
}

function contentOf(entry: TranscriptEntry) {
  if (entry.kind !== "tool_result") throw new Error(`expected tool_result, got ${entry.kind}`);
  return entry.content;
}

function textOf(entry: TranscriptEntry) {
  if (entry.kind !== "stdout") throw new Error(`expected stdout, got ${entry.kind}`);
  return entry.text;
}

describe("redactCommandText github tokens", () => {
  it("redacts a fine-grained personal access token", () => {
    expect(redactCommandText(`gh auth login --with-token ${FINE_GRAINED_PAT}`)).not.toContain(FINE_GRAINED_PAT);
  });

  it("still redacts classic personal access tokens", () => {
    expect(redactCommandText(`echo ${CLASSIC_PAT}`)).toBe(`echo ${REDACTED_COMMAND_TEXT_VALUE}`);
  });

  it("scrubs any credential embedded in a remote url", () => {
    expect(redactCommandText("git remote add origin https://someuser:hunter2@git.example.com/acme/widgets.git")).toBe(
      `git remote add origin https://someuser:${REDACTED_COMMAND_TEXT_VALUE}@git.example.com/acme/widgets.git`,
    );
  });

  it("leaves credential-free urls alone", () => {
    const url = "git clone https://github.com/acme/widgets.git";
    expect(redactCommandText(url)).toBe(url);
  });
});

describe("redactTranscriptEntryPaths secret scrubbing", () => {
  it("redacts a fine-grained token in git remote output (the FEA-476 case)", () => {
    const redacted = contentOf(redactTranscriptEntryPaths(toolResult(REMOTE_LINE)));
    expect(redacted).not.toContain(FINE_GRAINED_PAT);
    expect(redacted).toContain(REDACTED_COMMAND_TEXT_VALUE);
    expect(redacted).toContain("github.com/acme/widgets.git");
  });

  it("redacts a bare fine-grained token in stdout", () => {
    expect(textOf(redactTranscriptEntryPaths(stdout(FINE_GRAINED_PAT)))).toBe(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a classic token in a tool result, independently of the fine-grained gap", () => {
    expect(contentOf(redactTranscriptEntryPaths(toolResult(CLASSIC_PAT)))).toBe(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts secrets in tool call input", () => {
    const entry = redactTranscriptEntryPaths({
      kind: "tool_call",
      ts: "2026-01-01T00:00:00.000Z",
      toolUseId: "u1",
      name: "Bash",
      input: { command: `git push https://x-access-token:${FINE_GRAINED_PAT}@github.com/acme/widgets.git` },
    });
    expect(JSON.stringify(entry)).not.toContain(FINE_GRAINED_PAT);
  });

  it("scrubs secrets even when home-path masking is disabled", () => {
    const redacted = contentOf(redactTranscriptEntryPaths(toolResult(REMOTE_LINE), { enabled: false }));
    expect(redacted).not.toContain(FINE_GRAINED_PAT);
  });

  it("still masks home path user segments", () => {
    expect(textOf(redactTranscriptEntryPaths(stdout("/Users/sagiw/Dev/paperclip")))).toBe("/Users/s****/Dev/paperclip");
  });
});
