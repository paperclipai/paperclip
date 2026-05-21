import { describe, expect, it } from "vitest";
import { buildSandboxNpmInstallCommand } from "./sandbox-install-command.js";

describe("buildSandboxNpmInstallCommand", () => {
  it("installs globally as root, via sudo when available, and under ~/.local otherwise", () => {
    const command = buildSandboxNpmInstallCommand("@google/gemini-cli");
    expect(command).toContain("if [ \"$(id -u)\" -eq 0 ]; then npm install -g '@google/gemini-cli';");
    expect(command).toContain("sudo -E npm install -g '@google/gemini-cli'");
    expect(command).toContain("npm install -g --prefix \"$HOME/.local\" '@google/gemini-cli'");
  });

  it("bootstraps npm from a portable Node tarball when missing", () => {
    const command = buildSandboxNpmInstallCommand("@google/gemini-cli");
    expect(command).toContain("if ! command -v npm >/dev/null 2>&1; then");
    expect(command).toContain("https://nodejs.org/dist/");
    expect(command).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("shell-quotes package names", () => {
    expect(buildSandboxNpmInstallCommand("odd'pkg")).toContain("'odd'\"'\"'pkg'");
  });
});
