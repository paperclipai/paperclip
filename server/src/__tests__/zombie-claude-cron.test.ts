import { describe, expect, it } from "vitest";

// --- Layer 2: Cron script logic ---
// We test the pure logic of identifying zombie claude processes by importing
// the parser/filter functions from the cron script helper module.

import {
  parseProcessLine,
  shouldKillProcess,
  CPU_THRESHOLD_SECONDS,
} from "../services/zombie-claude-filter.js";

describe("zombie claude cron filter", () => {
  it("identifies a claude process with high CPU time for killing", () => {
    // 400 CPU-minutes = 06:40:00 in HH:MM:SS format
    const line = "06:40:00 12345 /Users/user/.claude/local/claude --run";
    const parsed = parseProcessLine(line);
    expect(parsed).not.toBeNull();
    expect(shouldKillProcess(parsed!)).toBe(true);
  });

  it("spares a claude process with normal CPU time", () => {
    // 60 CPU-minutes = 01:00:00
    const line = "01:00:00 54321 /Users/user/.claude/local/claude --run";
    const parsed = parseProcessLine(line);
    expect(parsed).not.toBeNull();
    expect(shouldKillProcess(parsed!)).toBe(false);
  });

  it("spares a non-claude process with high CPU time", () => {
    // 500 CPU-minutes = 08:20:00 but process is "node server.js" not claude
    const line = "08:20:00 99999 node /Users/user/Developer/paperclip/server/src/index.ts";
    const parsed = parseProcessLine(line);
    expect(parsed).not.toBeNull();
    expect(shouldKillProcess(parsed!)).toBe(false);
  });
});
