import pc from "picocolors";

export function printGoogleAdkStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const content = parsed.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    let printed = false;
    for (const part of parts) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const text = typeof (part as Record<string, unknown>).text === "string"
        ? ((part as Record<string, unknown>).text as string).trim()
        : "";
      if (text) {
        console.log(pc.green(`assistant: ${text}`));
        printed = true;
      }
    }
    if (!printed) console.log(line);
  } catch {
    console.log(line);
  }
}
