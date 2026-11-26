import { describe, expect, it } from "vitest";
import { parseLeadingUserCommand } from "./leading-user-command.js";

const plan = ["plan"] as const;

describe("parseLeadingUserCommand", () => {
  it("reads a leading allowlisted command and its argument text", () => {
    expect(parseLeadingUserCommand("/plan Add a greeting file", plan)).toEqual({ command: "plan", argument: "Add a greeting file" });
    expect(parseLeadingUserCommand("/plan", plan)).toEqual({ command: "plan", argument: "" });
    expect(parseLeadingUserCommand("/plan\n\nLine one\nLine two  ", plan)).toEqual({ command: "plan", argument: "Line one\nLine two" });
  });

  it("allows leading whitespace and newlines", () => {
    expect(parseLeadingUserCommand("  \n\t/plan go", plan)).toEqual({ command: "plan", argument: "go" });
  });

  it("uses the native server's whitespace, not JavaScript's", () => {
    // Python str patterns treat U+001C-U+001F as whitespace; JavaScript \s does not.
    expect(parseLeadingUserCommand("\u001c/plan\u001fgo", plan)).toEqual({ command: "plan", argument: "go" });
    expect(parseLeadingUserCommand(" /plan　go", plan)).toEqual({ command: "plan", argument: "go" });
    // JavaScript \s includes U+FEFF; Python does not, so it is not a separator.
    expect(parseLeadingUserCommand("﻿/plan go", plan)).toBeNull();
    expect(parseLeadingUserCommand("/plan﻿go", plan)).toBeNull();
  });

  it("ignores a command that is not at the start", () => {
    expect(parseLeadingUserCommand("Please /plan this first", plan)).toBeNull();
    expect(parseLeadingUserCommand("Context\n/plan this", plan)).toBeNull();
  });

  it("ignores quoted, pasted, forwarded or wrapped content", () => {
    expect(parseLeadingUserCommand("> /plan from a quoted reply", plan)).toBeNull();
    expect(parseLeadingUserCommand("```\n/plan\n```", plan)).toBeNull();
    expect(parseLeadingUserCommand("`/plan` is a command", plan)).toBeNull();
    expect(parseLeadingUserCommand("---------- Forwarded message ----------\n/plan x", plan)).toBeNull();
    expect(parseLeadingUserCommand("<untrusted>/plan x</untrusted>", plan)).toBeNull();
    expect(parseLeadingUserCommand("\\/plan ordinary text", plan)).toBeNull();
    expect(parseLeadingUserCommand("⁠/plan neutralised", plan)).toBeNull();
  });

  it("matches the exact lower-case name only", () => {
    expect(parseLeadingUserCommand("/PLAN x", plan)).toBeNull();
    expect(parseLeadingUserCommand("/Plan x", plan)).toBeNull();
    expect(parseLeadingUserCommand("/planning notes", plan)).toBeNull();
    expect(parseLeadingUserCommand("/plans", plan)).toBeNull();
  });

  it("does not read a path or URL as a command", () => {
    expect(parseLeadingUserCommand("/plan/2026/notes.md", plan)).toBeNull();
    expect(parseLeadingUserCommand("/plan?draft=1", plan)).toBeNull();
    expect(parseLeadingUserCommand("https://example.com/plan x", plan)).toBeNull();
  });

  it("accepts only allowlisted commands", () => {
    expect(parseLeadingUserCommand("/swarm build it", plan)).toBeNull();
    expect(parseLeadingUserCommand("/logout", plan)).toBeNull();
    expect(parseLeadingUserCommand("/swarm build it", ["plan", "swarm"])).toEqual({ command: "swarm", argument: "build it" });
    expect(parseLeadingUserCommand("/plan x", [])).toBeNull();
  });
});
