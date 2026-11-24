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

  it.each([
    "The page says login required for guests.",
    "Login test: authentication failed, the bearer token is invalid as expected.",
  ])("ignores auth prose in a max-turns summary: %s", (result) => {
    expect(detectClaudeLoginRequired({
      parsed: { subtype: "error_max_turns", is_error: true, result },
      stdout: "",
      stderr: "",
    }).requiresLogin).toBe(false);
  });

  it("recognizes the structured max-turns stop reason when excluding summary prose", () => {
    expect(detectClaudeLoginRequired({
      parsed: { subtype: "error", is_error: true, stop_reason: "max_turns", result: "Test expects unauthorized." },
      stdout: "",
      stderr: "",
    }).requiresLogin).toBe(false);
  });

  it.each([
    { api_error_status: 401 },
    { error_status: 401 },
    { error: "authentication_failed" },
    { errors: ["Invalid bearer token"] },
    { errors: [{ message: "Not logged in. Please run /login" }] },
  ])("preserves provider auth evidence alongside a max-turns summary: %j", (evidence) => {
    expect(detectClaudeLoginRequired({
      parsed: { subtype: "error_max_turns", is_error: true, result: "The checks passed.", ...evidence },
      stdout: "",
      stderr: "",
    }).requiresLogin).toBe(true);
  });

  it("preserves a plain CLI login diagnostic on stderr after a max-turns result", () => {
    expect(detectClaudeLoginRequired({
      parsed: { subtype: "error_max_turns", is_error: true, result: "The checks passed." },
      stdout: "",
      stderr: "Invalid API key · Please run /login",
    }).requiresLogin).toBe(true);
  });

  it.each([null, { subtype: "error_max_turns", is_error: true }])(
    "excludes multiple JSON transcript records from both diagnostic streams with result %j",
    (parsed) => {
      const transcript = [
        { type: "user", message: { content: [{ type: "text", text: "The server rejects unauthorized recipients." }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Please run /login is an example." }] } },
        { type: "user", message: { content: [{ type: "tool_result", content: "You are not logged into any GitHub hosts." }] } },
      ].map((event) => JSON.stringify(event)).join("\n");
      expect(detectClaudeLoginRequired({ parsed, stdout: transcript, stderr: transcript }).requiresLogin).toBe(false);
    },
  );
});
