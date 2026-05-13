import pc from "picocolors";

export function printKilocodeGatewayStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    if (line.startsWith("data: ") && !line.includes("[DONE]")) {
      try {
        const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const first = choices[0] as Record<string, unknown> | undefined;
        const delta = first?.delta as Record<string, unknown> | undefined;
        const content = typeof delta?.content === "string" ? delta.content : null;
        if (content !== null) {
          process.stdout.write(content);
          return;
        }
      } catch {
        // fall through
      }
    }
    console.log(line);
    return;
  }

  if (line.startsWith("data: ")) {
    console.log(pc.cyan(line));
    return;
  }

  console.log(pc.gray(line));
}
