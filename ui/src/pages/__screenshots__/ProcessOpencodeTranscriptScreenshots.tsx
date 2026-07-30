// Static before/after rendering of an OpenCode run executed through the
// generic process adapter, captured for PR review.
//
// Reachable only in dev (`import.meta.env.DEV`) at
// `/tests/screenshots/process-opencode-transcript`. The capture script under
// `tools/process-opencode-transcript-screenshots/capture.mjs` boots the vite
// dev server, navigates here, and screenshots each `<section
// data-screenshot-id>`.
//
// "Before" reproduces the previous pass-through parser (every stdout line
// becomes a raw stdout entry); "after" runs the same stream through the real
// process adapter module — the exact path the Run page uses — so the
// screenshots show precisely what this PR changes.

import type { ReactNode } from "react";
import type { TranscriptEntry } from "../../adapters";
import { buildTranscript, type RunLogChunk } from "../../adapters/transcript";
import { processUIAdapter } from "../../adapters/process";
import { RunTranscriptView } from "../../components/transcript/RunTranscriptView";
import { Badge } from "@/components/ui/badge";

const ts = "2026-07-04T12:00:00.000Z";

// A representative process-adapter run: a wrapper script prints two plain
// bootstrap lines, then execs an OpenCode harness that emits OpenCode JSONL.
const MIXED_STREAM_LINES: string[] = [
  "Syncing skills ...",
  "Starting agent ...",
  JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } }),
  JSON.stringify({
    type: "reasoning",
    sessionID: "ses_x",
    part: { type: "reasoning", text: "The board asked for a hiring plan. I should check the current staffing files first." },
  }),
  JSON.stringify({
    type: "text",
    sessionID: "ses_x",
    part: { type: "text", text: "I'll review the current staffing files, then draft the hiring plan." },
  }),
  JSON.stringify({
    type: "tool_use",
    part: {
      type: "tool",
      tool: "bash",
      callID: "tool-1",
      state: {
        status: "completed",
        input: { command: "ls docs/staffing" },
        output: "headcount.md\nhiring-plan-q2.md",
      },
    },
  }),
  JSON.stringify({
    type: "text",
    sessionID: "ses_x",
    part: { type: "text", text: "Found the Q2 plan — I'll extend it with the two open engineering roles." },
  }),
  JSON.stringify({
    type: "step_finish",
    part: { reason: "tool-calls", tokens: { input: 9338, output: 59, reasoning: 559 } },
  }),
];

function mixedStreamChunks(): RunLogChunk[] {
  return [{ ts, stream: "stdout", chunk: MIXED_STREAM_LINES.join("\n") + "\n" }];
}

// The previous parser wrapped every line as raw stdout — reproduce it verbatim
// so the "before" section shows what the Run page used to render.
const beforeEntries: TranscriptEntry[] = MIXED_STREAM_LINES.map((line) => ({
  kind: "stdout",
  ts,
  text: line,
}));

const afterEntries: TranscriptEntry[] = buildTranscript(mixedStreamChunks(), processUIAdapter);

function ScreenshotSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      data-screenshot-id={id}
      className="w-[960px] rounded-xl border border-border/70 bg-background p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <Badge variant="outline" className="uppercase tracking-[0.18em] text-[10px]">
          {title}
        </Badge>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      {children}
    </section>
  );
}

export function ProcessOpencodeTranscriptScreenshots() {
  return (
    <div className="flex min-h-screen flex-col items-start gap-8 bg-muted/30 p-8">
      <ScreenshotSection
        id="01-before-raw-jsonl-passthrough"
        title="Before"
        description="Process adapter pass-through: OpenCode JSONL dumped as raw stdout"
      >
        <RunTranscriptView entries={beforeEntries} mode="nice" />
      </ScreenshotSection>

      <ScreenshotSection
        id="02-after-rich-opencode-transcript"
        title="After"
        description="Same stream with OpenCode JSONL detection: bootstrap lines stay raw, the rest renders richly"
      >
        <RunTranscriptView entries={afterEntries} mode="nice" />
      </ScreenshotSection>
    </div>
  );
}
