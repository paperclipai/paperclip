import { describe, expect, it } from "vitest";
import { buildSandboxNpmInstallCommand } from "./sandbox-install-command.js";

describe("buildSandboxNpmInstallCommand", () => {
  it("installs globally as root, via sudo when available, and under ~/.local otherwise", () => {
    expect(buildSandboxNpmInstallCommand("@google/gemini-cli")).toBe(
      'if [ "$(id -u)" -eq 0 ]; then npm install -g \'@google/gemini-cli\'; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -E npm install -g \'@google/gemini-cli\'; else mkdir -p "$HOME/.local" && npm install -g --prefix "$HOME/.local" \'@google/gemini-cli\'; fi',
    );
  });

  it("shell-quotes package names", () => {
    expect(buildSandboxNpmInstallCommand("odd'pkg")).toContain("'odd'\"'\"'pkg'");
  });
});
