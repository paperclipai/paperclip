import { describe, expect, it } from "vitest";
import { formatPiProgressMessage, summarizeProgressToolInput } from "./execute.js";

describe("summarizeProgressToolInput", () => {
  it("hides raw string args", () => {
    expect(summarizeProgressToolInput("token=secret-value")).toBeNull();
  });

  it("redacts command args by field count", () => {
    expect(
      summarizeProgressToolInput({
        command: "bash -lc 'curl https://example.com?token=secret'",
      }),
    ).toBe("1 field");
  });

  it("redacts cmd args by field count", () => {
    expect(
      summarizeProgressToolInput({
        cmd: "bash -lc 'curl https://example.com?token=secret'",
        cwd: "/tmp",
      }),
    ).toBe("2 fields");
  });

  it("summarizes object args by field count", () => {
    expect(
      summarizeProgressToolInput({
        path: "/tmp/secret.txt",
        token: "secret-value",
      }),
    ).toBe("2 fields");
  });
});

describe("formatPiProgressMessage", () => {
  it("omits raw string tool args from progress logs", () => {
    const state = { sawThinking: false };
    const message = formatPiProgressMessage(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: "token=secret-value",
      }),
      state,
    );

    expect(message).toBe("[paperclip] Pi tool running: read.");
  });

  it("reports object args by field count", () => {
    const state = { sawThinking: false };
    const message = formatPiProgressMessage(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: {
          path: "/tmp/secret.txt",
          token: "secret-value",
        },
      }),
      state,
    );

    expect(message).toBe("[paperclip] Pi tool running: read (2 fields).");
  });
});
