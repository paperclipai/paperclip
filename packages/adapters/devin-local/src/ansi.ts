/**
 * Strip ANSI escape sequences (CSI and OSC) from terminal text.
 * Keeps pattern matching and summary extraction working when Devin `-p` emits
 * colored output (e.g. black foreground codes that hide prompts).
 *
 * Shared by the server-side output parser and the browser-bundled UI stdout
 * parser; must stay dependency-free and side-effect free.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
