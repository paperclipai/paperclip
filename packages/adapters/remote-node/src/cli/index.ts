import pc from "picocolors";

export function printRemoteNodeStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "system") {
    const message = typeof parsed.message === "string" ? parsed.message : line;
    console.log(pc.blue(`[remote_node] ${message}`));
    return;
  }

  if (type === "assistant") {
    const message = typeof parsed.message === "string" ? parsed.message : "";
    if (message) console.log(pc.green(`assistant: ${message}`));
    return;
  }

  if (type === "result") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    if (subtype || isError) {
      console.log(pc.blue(`[remote_node] result: subtype=${subtype} is_error=${isError}`));
    }
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
