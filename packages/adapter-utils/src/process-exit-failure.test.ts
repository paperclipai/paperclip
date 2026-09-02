import { describe, expect, it } from "vitest";
import { describeProcessExitFailure } from "./server-utils.js";

describe("describeProcessExitFailure", () => {
  it("names the cause from the tail of stderr instead of just the exit code", () => {
    const message = describeProcessExitFailure({
      exitCode: 1,
      stdout: "starting agent runtime\n",
      stderr:
        "fetching board state\nBoard call failed: expected JSON from https://board.example.com/api/agents/me, got text/html\n",
    });

    expect(message).toBe(
      "Process exited with code 1: fetching board state | "
        + "Board call failed: expected JSON from https://board.example.com/api/agents/me, got text/html",
    );
  });

  it("falls back to the bare summary when the child printed nothing", () => {
    expect(describeProcessExitFailure({ exitCode: 3, stdout: "", stderr: "   \n\n" })).toBe(
      "Process exited with code 3",
    );
    expect(describeProcessExitFailure({ exitCode: null })).toBe("Process exited with code -1");
  });

  it("uses stdout when the child logged its fatal error there", () => {
    expect(describeProcessExitFailure({ exitCode: 1, stdout: "config error: missing board url\n", stderr: "" })).toBe(
      "Process exited with code 1: config error: missing board url",
    );
  });

  it("skips stack frames so the excerpt lands on the thrown message", () => {
    const message = describeProcessExitFailure({
      exitCode: 1,
      stderr: [
        "Error: PAPERCLIP_API_URL did not return JSON",
        "    at makeBoard (/app/board.js:12:11)",
        "    at main (/app/index.js:4:3)",
        "Require stack:",
        "- /app/index.js",
      ].join("\n"),
    });

    expect(message).toBe("Process exited with code 1: Error: PAPERCLIP_API_URL did not return JSON");
  });

  it("keeps stack frames when they are all the child gave us", () => {
    const message = describeProcessExitFailure({
      exitCode: 1,
      stderr: "    at makeBoard (/app/board.js:12:11)\n    at main (/app/index.js:4:3)\n",
    });

    expect(message).toContain("at main (/app/index.js:4:3)");
  });

  it("redacts secrets that a crashing child echoed into its diagnostics", () => {
    const message = describeProcessExitFailure({
      exitCode: 1,
      stderr: 'request failed with {"api_key":"super-secret-value"}\n',
    });

    expect(message).not.toContain("super-secret-value");
    expect(message).toContain("***REDACTED***");
  });

  it("bounds the excerpt so errorReason stays readable", () => {
    const message = describeProcessExitFailure({
      exitCode: 1,
      stderr: `${"x".repeat(5000)}\n`,
    });

    expect(message.length).toBeLessThanOrEqual("Process exited with code 1: ".length + 320);
    expect(message.endsWith("…")).toBe(true);
  });
});
