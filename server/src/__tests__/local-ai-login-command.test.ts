import { describe, expect, it } from "vitest";
import { localAiLoginCommand } from "../services/local-ai-login-command.js";

const dir = "/home/paperclip/.paperclip/instances/default/ai-local-logins/abc";

describe("local sign-in command", () => {
  it("hands the login folder to the server account, so a root terminal cannot leave root-owned credentials", () => {
    expect(localAiLoginCommand("anthropic", dir, { uid: 996, gid: 995 })).toBe(
      `(export CLAUDE_CONFIG_DIR='${dir}' && mkdir -p "$CLAUDE_CONFIG_DIR" && claude auth login && chown -R 996:995 "$CLAUDE_CONFIG_DIR")`,
    );
    expect(localAiLoginCommand("openai", dir, { uid: 996, gid: 995 })).toContain(
      `login --device-auth && chown -R 996:995 "$CODEX_HOME")`,
    );
    expect(localAiLoginCommand("xai", dir, { uid: 996, gid: 995 })).toContain(
      `grok login --device-auth && chown -R 996:995 "$GROK_HOME")`,
    );
  });

  it("keeps the plain command when the server account has no numeric id", () => {
    expect(localAiLoginCommand("anthropic", dir, {})).toBe(
      `(export CLAUDE_CONFIG_DIR='${dir}' && mkdir -p "$CLAUDE_CONFIG_DIR" && claude auth login)`,
    );
  });

  it("quotes a folder name that contains a single quote", () => {
    expect(localAiLoginCommand("anthropic", "/a'b", {})).toContain(`CLAUDE_CONFIG_DIR='/a'\\''b'`);
  });
});
