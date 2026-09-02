const PI_BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const PI_WINDOWS_SHELL_GUIDANCE = [
  "## Windows shell tools",
  "",
  "On Windows, Pi exposes separate `bash` and `powershell` tools.",
  "",
  "- Use the `powershell` tool for PowerShell-native syntax: Get-ChildItem, Where-Object, ForEach-Object, `$_, `$variables, `$env:, script blocks `{ }`, and Windows process or service commands.",
  "- Never send PowerShell expressions through the `bash` tool. Bash expands `$_` and other `$` tokens before PowerShell sees them, which breaks commands like `Where-Object { $_.PSIsContainer }`.",
  "- Use the `bash` tool only for Bash-compatible commands (Git, Unix-style pipelines, and similar).",
].join("\n");

export function resolvePiToolAllowlist(platform: NodeJS.Platform = process.platform): string {
  const tools = platform === "win32" ? [...PI_BASE_TOOLS.slice(0, 2), "powershell", ...PI_BASE_TOOLS.slice(2)] : [...PI_BASE_TOOLS];
  return tools.join(",");
}

export function appendPiWindowsShellGuidance(
  systemPrompt: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || systemPrompt.includes(PI_WINDOWS_SHELL_GUIDANCE)) {
    return systemPrompt;
  }
  const trimmed = systemPrompt.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${PI_WINDOWS_SHELL_GUIDANCE}` : PI_WINDOWS_SHELL_GUIDANCE;
}
