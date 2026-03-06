import pc from "picocolors";

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (
    trimmed.startsWith("─") || trimmed.startsWith("╭") ||
    trimmed.startsWith("╰") || trimmed.startsWith("│") ||
    /^GitHub Copilot\s/i.test(trimmed) || /^I'm powered by AI/i.test(trimmed)
  ) return;

  if (/warning|trust|note:/i.test(trimmed)) {
    console.log(pc.yellow(`[copilot] ${trimmed}`));
    return;
  }
  if (trimmed.startsWith(">") || trimmed.startsWith("#")) {
    console.log(pc.gray(trimmed));
    return;
  }
  console.log(pc.cyan(trimmed));

  if (debug) {
    // nothing extra for copilot — output is plain text, not structured JSON
  }
}
