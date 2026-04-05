import pc from "picocolors";

export function printQodoStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { console.log(line); return; }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "assistant") {
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "error") {
    const message = typeof parsed.message === "string" ? parsed.message : "unknown error";
    console.log(pc.red(`error: ${message}`));
    return;
  }

  if (type === "result") {
    const text = typeof parsed.result === "string" ? parsed.result : "";
    if (text) { console.log(pc.green("result:")); console.log(text); }
    return;
  }

  if (debug) console.log(pc.gray(line));
}
