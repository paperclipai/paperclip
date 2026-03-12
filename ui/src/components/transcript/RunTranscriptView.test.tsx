import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunTranscriptView } from "./RunTranscriptView";
import { ThemeProvider } from "../../context/ThemeContext";

function renderWithTheme(node: ReactNode) {
  return renderToStaticMarkup(<ThemeProvider>{node}</ThemeProvider>);
}

describe("RunTranscriptView", () => {
  it("renders a readable transcript view by default", () => {
    const html = renderWithTheme(
      <RunTranscriptView
        entries={[
          {
            kind: "assistant",
            ts: "2026-03-10T10:00:00.000Z",
            text: "Completed the roadmap follow-through.",
          },
          {
            kind: "tool_call",
            ts: "2026-03-10T10:00:01.000Z",
            name: "shell",
            input: { command: "git status" },
          },
          {
            kind: "tool_result",
            ts: "2026-03-10T10:00:02.000Z",
            toolUseId: "tool-1",
            content: "{\"summary\":\"working tree clean\"}",
            isError: false,
          },
        ]}
      />,
    );

    expect(html).toContain("Assistant");
    expect(html).toContain("Completed the roadmap follow-through.");
    expect(html).toContain("shell");
    expect(html).toContain("working tree clean");
  });

  it("renders raw log rows when raw mode is selected", () => {
    const html = renderWithTheme(
      <RunTranscriptView
        mode="raw"
        entries={[]}
        rawLines={[
          {
            ts: "2026-03-10T10:00:00.000Z",
            stream: "stderr",
            chunk: "fatal: not a git repository",
          },
        ]}
      />,
    );

    expect(html).toContain("stderr");
    expect(html).toContain("fatal: not a git repository");
  });
});
