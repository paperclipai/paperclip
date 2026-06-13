// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  hasMixedCodexAuthModes,
  toggleCredentialSelectionForAuthMode,
} from "./credential-selection";

const credentials = [
  { id: "codex-1", type: "codex_oauth" },
  { id: "codex-2", type: "codex_oauth" },
  { id: "openai-1", type: "openai_api_key" },
  { id: "claude-1", type: "claude_oauth" },
];

describe("credential selection auth mode helpers", () => {
  it("allows multiple Codex OAuth credentials to form a rotation pool", () => {
    expect(toggleCredentialSelectionForAuthMode(credentials, ["codex-1"], "codex-2")).toEqual([
      "codex-1",
      "codex-2",
    ]);
  });

  it("switches from Codex OAuth mode to OpenAI API-key mode", () => {
    expect(toggleCredentialSelectionForAuthMode(credentials, ["codex-1", "codex-2"], "openai-1")).toEqual([
      "openai-1",
    ]);
  });

  it("switches from OpenAI API-key mode to Codex OAuth mode", () => {
    expect(toggleCredentialSelectionForAuthMode(credentials, ["openai-1"], "codex-1")).toEqual([
      "codex-1",
    ]);
  });

  it("allows Codex OAuth and OpenAI API-key credentials when auth-mode enforcement is disabled", () => {
    expect(
      toggleCredentialSelectionForAuthMode(credentials, ["codex-1"], "openai-1", {
        enforceCodexAuthMode: false,
      }),
    ).toEqual(["codex-1", "openai-1"]);
  });

  it("detects persisted mixed Codex auth mode selections", () => {
    expect(hasMixedCodexAuthModes(credentials, ["codex-1", "openai-1"])).toBe(true);
    expect(hasMixedCodexAuthModes(credentials, ["codex-1", "codex-2"])).toBe(false);
  });

  it("leaves unrelated provider credentials selected", () => {
    expect(toggleCredentialSelectionForAuthMode(credentials, ["claude-1"], "codex-1")).toEqual([
      "claude-1",
      "codex-1",
    ]);
  });
});
