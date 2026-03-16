import pc from "picocolors";

export function printNanobotLocalStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    console.log(line);
    return;
  }

  if (line.startsWith("[nanobot-local]")) {
    console.log(pc.blue(line));
    return;
  }

  console.log(pc.gray(line));
}
