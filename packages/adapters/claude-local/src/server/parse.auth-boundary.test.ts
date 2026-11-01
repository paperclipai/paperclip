import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired } from "./parse.js";

const documentText = "PhoneAuth rejects (unauthorized, reason identity_mismatch) an unexpected OTP identity.";

describe("Claude authentication evidence boundary", () => {
  it.each([documentText, "Please run /login", "Authentication required"])(
    "ignores ordinary successful output: %s",
    (text) => {
      expect(detectClaudeLoginRequired({
        parsed: { subtype: "success", is_error: false, result: text },
        stdout: JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } }),
        stderr: text,
      }).requiresLogin).toBe(false);
    },
  );

  it.each([null, { subtype: "error_max_turns", is_error: true }])(
    "does not treat a tool transcript as an authentication failure with result %j",
    (parsed) => {
      expect(detectClaudeLoginRequired({
        parsed,
        stdout: JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: documentText }] } }),
        stderr: "",
      }).requiresLogin).toBe(false);
    },
  );

  it.each([
    { subtype: "error", is_error: true, result: "Unauthorized. Please run /login" },
    { subtype: "success", is_error: true, api_error_status: 401, result: "Invalid bearer token" },
    { subtype: "error", errors: ["Authentication required"] },
    { subtype: "success", is_error: false, api_error_status: 401 },
  ])("preserves structured authentication failures: %j", (parsed) => {
    expect(detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin).toBe(true);
  });

  it.each(["stdout", "stderr"] as const)("preserves plain startup login errors on %s", (stream) => {
    expect(detectClaudeLoginRequired({ parsed: null, stdout: "", stderr: "", [stream]: "Not logged in. Please run /login" }).requiresLogin).toBe(true);
  });
});
