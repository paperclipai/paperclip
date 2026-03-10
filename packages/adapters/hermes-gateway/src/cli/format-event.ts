import pc from "picocolors";

export function printHermesGatewayStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  if (!debug) {
    console.log(line);
    return;
  }
  if (line.startsWith("[hermes-gateway]")) {
    console.log(pc.magenta(line));
    return;
  }
  console.log(pc.gray(line));
}
