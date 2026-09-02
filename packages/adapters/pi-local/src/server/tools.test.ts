import { describe, expect, it } from "vitest";
import {
  PI_WINDOWS_SHELL_GUIDANCE,
  appendPiWindowsShellGuidance,
  resolvePiToolAllowlist,
} from "./tools.js";

describe("pi local tool allowlist", () => {
  it("includes the native PowerShell tool on Windows", () => {
    expect(resolvePiToolAllowlist("win32")).toBe("read,bash,powershell,edit,write,grep,find,ls");
  });

  it("keeps the Linux tool set unchanged on non-Windows platforms", () => {
    expect(resolvePiToolAllowlist("linux")).toBe("read,bash,edit,write,grep,find,ls");
    expect(resolvePiToolAllowlist("darwin")).toBe("read,bash,edit,write,grep,find,ls");
  });
});

describe("pi local Windows shell guidance", () => {
  it("appends Windows shell guidance once on win32", () => {
    const prompt = appendPiWindowsShellGuidance("Base prompt.", "win32");
    expect(prompt).toContain("Base prompt.");
    expect(prompt).toContain(PI_WINDOWS_SHELL_GUIDANCE);
    expect(prompt).toContain("Where-Object { $_.PSIsContainer }");
    expect(appendPiWindowsShellGuidance(prompt, "win32")).toBe(prompt);
  });

  it("does not append Windows shell guidance on non-Windows platforms", () => {
    expect(appendPiWindowsShellGuidance("Base prompt.", "linux")).toBe("Base prompt.");
  });

  it("documents why PowerShell must not pass through bash", () => {
    const bashExpanded = "Where-Object { /usr/bin/bash.PSIsContainer }";
    expect(bashExpanded).toContain("/usr/bin/bash.PSIsContainer");
    expect(bashExpanded).not.toContain("$_.PSIsContainer");
    expect(PI_WINDOWS_SHELL_GUIDANCE).toContain("Bash expands `$_`");
  });
});
