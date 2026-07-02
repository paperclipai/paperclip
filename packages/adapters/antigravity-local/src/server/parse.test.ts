import { describe, expect, it } from "vitest";
import {
  detectAntigravityAuthRequired,
  parseAntigravityCliLogForConversationId,
  parseAntigravityOutput,
} from "./parse.js";

describe("antigravity_local parser", () => {
  it("treats agy --print stdout as the final summary", () => {
    const parsed = parseAntigravityOutput({
      stdout: "hello\n",
      stderr: "",
      cliLog: "",
    });

    expect(parsed.summary).toBe("hello");
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts the latest conversation id from the agy CLI log", () => {
    const log = [
      "I0702 13:13:32.040071 conversation_manager.go:306] Starting new conversation (agent=false)",
      "I0702 13:13:32.061151 server.go:807] Created conversation 11111111-1111-4111-8111-111111111111",
      "I0702 13:13:32.064695 printmode.go:179] Print mode: conversation=22222222-2222-4222-8222-222222222222, sending message",
    ].join("\n");

    expect(parseAntigravityCliLogForConversationId(log)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("uses the agy CLI log session id when stdout has no session marker", () => {
    const parsed = parseAntigravityOutput({
      stdout: "done\n",
      stderr: "",
      cliLog: "I0702 printmode.go:179] Print mode: conversation=33333333-3333-4333-8333-333333333333, sending message",
    });

    expect(parsed.sessionId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("does not invent a session id from arbitrary UUID text in stdout", () => {
    const parsed = parseAntigravityOutput({
      stdout: "Updated issue 44444444-4444-4444-8444-444444444444\n",
      stderr: "",
      cliLog: "",
    });

    expect(parsed.sessionId).toBeNull();
  });

  it("detects Antigravity auth errors without flagging normal output", () => {
    expect(detectAntigravityAuthRequired("", "error getting token source")).toBe(true);
    expect(detectAntigravityAuthRequired("", "Run agy auth login to continue")).toBe(true);
    expect(detectAntigravityAuthRequired("Task completed", "")).toBe(false);
  });
});
