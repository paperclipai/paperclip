// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../adapters";
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
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("hides all informational [paperclip] stderr during normalization", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Skipping saved session resume for task \"PAP-485\" because wake reason is issue_assigned.",
      },
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.100Z",
        text: "[paperclip] No project or prior session workspace was available. Using fallback workspace /tmp/ws",
      },
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.200Z",
        text: "[paperclip] Injected Codex skill from /home/user/.paperclip/skills/codex.md",
      },
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.300Z",
        text: "[paperclip] Loaded agent instructions file agents/coder/AGENTS.md",
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

  it("keeps [paperclip] stderr containing error keywords visible", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Fatal error: adapter crashed during execution",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Something went wrong.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    const stderrBlock = blocks.find((b) => b.type === "event" && "label" in b && b.label === "stderr");
    expect(stderrBlock).toBeDefined();
  });

  it("keeps non-paperclip stderr visible during normalization", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "npm ERR! code ENOENT",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Investigating the error.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    const stderrBlock = blocks.find((b) => b.type === "event" && "label" in b && b.label === "stderr");
    expect(stderrBlock).toBeDefined();
  });

  it("keeps [paperclip] stderr containing warning keyword visible", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Warning: adapter memory usage is high",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Continuing.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    const stderrBlock = blocks.find((b) => b.type === "event" && "label" in b && b.label === "stderr");
    expect(stderrBlock).toBeDefined();
  });

  it("hides [paperclip] stderr whose file path contains an error keyword but message is informational", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Loaded skill from /home/user/error-handler/codex.md",
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
});
