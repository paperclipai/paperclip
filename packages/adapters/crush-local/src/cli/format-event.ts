import pc from "picocolors";

export function printCrushStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (debug) {
    console.log(pc.gray(line));
    return;
  }

  console.log(pc.green(line));
}
