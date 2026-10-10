export function preferredShellForSandbox(shellCommand: string | null | undefined): "bash" | "sh" {
  return shellCommand === "bash" ? "bash" : "sh";
}

export function shellCommandArgs(script: string): string[] {
  return ["-c", script];
}
