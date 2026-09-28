import pc from "picocolors";

// Devin's `-p` print lane streams plain markdown (no JSON event stream), so the
// CLI `--watch` formatter simply colorizes adapter/orchestration bookkeeping
// lines distinctly from the agent's answer.

const ADAPTER_LINE = /^\s*\[(adapter|paperclip)\]/i;

export function printDevinStreamEvent(raw: string, debug: boolean): void {
  const line = raw.replace(/\r?\n$/, "");
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    if (debug) process.stdout.write("\n");
    return;
  }
  if (ADAPTER_LINE.test(line)) {
    // eslint-disable-next-line no-console
    console.log(pc.blue(line.trim()));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(pc.green(line));
}
