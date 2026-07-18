// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import type { TranscriptEntry } from "../../adapters";
import { buildTranscript, type RunLogChunk } from "../../adapters";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

describe("RunTranscriptView", () => {
  it("folds repeated tool_call status updates for the same toolUseId into one block", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:00.000Z",
        name: "read",
        toolUseId: "tool-1",
        input: { text: "read README.md", status: "pending" },
      },
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:01.000Z",
        name: "read",
        toolUseId: "tool-1",
        input: { status: "in_progress" },
      },
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:02.000Z",
        name: "search",
        toolUseId: "tool-2",
        input: { text: "grep TODO", status: "pending" },
      },
      {
        kind: "tool_result",
        ts: "2026-03-12T00:00:03.000Z",
        toolUseId: "tool-1",
        toolName: "read",
        content: "ok",
        isError: false,
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool_group",
      items: [
        {
          name: "Read",
          status: "completed",
          result: "ok",
          // Later status updates merge into the original input instead of
          // spawning duplicate "Running" cards.
          input: { text: "read README.md", status: "in_progress" },
        },
        { name: "Search", status: "running" },
      ],
    });
  });

  it("renders a streamed acpx tool call as a single card once completed", () => {
    const ts = "2026-03-12T00:00:00.000Z";
    const jsonLines = [
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-1", status: "pending", text: "read README.md" },
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-1", status: "in_progress", text: "read README.md" },
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-1", status: "completed", text: "ok" },
    ];
    const chunks: RunLogChunk[] = [
      { ts, stream: "stdout", chunk: jsonLines.map((line) => JSON.stringify(line)).join("\n") + "\n" },
    ];

    const entries = buildTranscript(chunks, parseAcpxStdoutLine);
    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool_group",
      items: [{ name: "Read", status: "completed", result: "ok" }],
    });
  });

  it("renders streamed acpx tool calls with input payloads as readable status cards", () => {
    const ts = "2026-03-12T00:00:00.000Z";
    const jsonLines = [
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-2", status: "running", input: { file: "README.md" } },
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-2", status: "in_progress", text: "opening file", input: { line: 1 } },
      { type: "acpx.tool_call", name: "read", toolCallId: "tool-2", status: "completed", text: "ok" },
    ];
    const chunks: RunLogChunk[] = [
      { ts, stream: "stdout", chunk: jsonLines.map((line) => JSON.stringify(line)).join("\n") + "\n" },
    ];

    const entries = buildTranscript(chunks, parseAcpxStdoutLine);
    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool_group",
      items: [{ name: "Read", status: "completed", result: "ok" }],
    });
  });

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
