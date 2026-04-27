import { describe, expect, it } from "vitest";
import { parseClaudeCliUsageText } from "./quota.js";

describe("parseClaudeCliUsageText", () => {
  it("parses compact Claude status-line usage windows", () => {
    expect(parseClaudeCliUsageText("Opus 4.6 | 5h: 42% | 7d: 23%")).toEqual([
      {
        label: "Current session",
        usedPercent: 42,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
      {
        label: "Current week (all models)",
        usedPercent: 23,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
    ]);
  });

  it("parses compact usage windows from ANSI-rendered terminal output", () => {
    const rendered = "\u001b[2K\r\u001b[36mSonnet 4.6\u001b[0m | 5h: 7.6% | 7d: 88.4%";

    expect(parseClaudeCliUsageText(rendered).map(({ label, usedPercent }) => ({ label, usedPercent }))).toEqual([
      { label: "Current session", usedPercent: 8 },
      { label: "Current week (all models)", usedPercent: 88 },
    ]);
  });
});
