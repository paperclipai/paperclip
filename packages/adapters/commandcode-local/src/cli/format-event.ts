import pc from "picocolors";

export function printCommandCodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  console.log(pc.green(`assistant: ${line}`));
}
