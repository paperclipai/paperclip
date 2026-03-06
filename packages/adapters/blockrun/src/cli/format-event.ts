import pc from "picocolors";

export function printBlockRunStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    // In non-debug mode, skip metadata lines and show only agent output
    if (line.startsWith("[blockrun]")) {
      if (line.includes("--- agent output ---") || line.includes("--- end output ---")) return;
      if (line.includes("model=") || line.includes("cost=$")) {
        console.log(pc.dim(line));
        return;
      }
      return;
    }
    console.log(line);
    return;
  }

  // Debug mode: color-code all output
  if (line.startsWith("[blockrun]")) {
    if (line.includes("error") || line.includes("failed")) {
      console.log(pc.red(line));
    } else if (line.includes("cost=$") || line.includes("payment")) {
      console.log(pc.yellow(line));
    } else {
      console.log(pc.cyan(line));
    }
    return;
  }

  console.log(pc.white(line));
}
