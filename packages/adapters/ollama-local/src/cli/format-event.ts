import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function printOllamaStreamEvent(raw: string, debug: boolean): void {
  const trimmed = raw.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (debug) console.log(pc.gray(trimmed));
    return;
  }

  const rec = asRecord(parsed);
  if (!rec) {
    if (debug) console.log(pc.gray(trimmed));
    return;
  }

  const type = asString(rec.type);

  if (type === "chunk") {
    const content = asString(rec.content);
    if (content) process.stdout.write(pc.green(content));
    return;
  }

  if (type === "done") {
    const model = asString(rec.model, "ollama");
    const inputTokens = asNumber(rec.prompt_eval_count, 0);
    const outputTokens = asNumber(rec.eval_count, 0);
    console.log();
    console.log(
      pc.gray(
        `[ollama] done — model: ${model}, tokens: ${inputTokens} in / ${outputTokens} out`,
      ),
    );
    return;
  }

  if (type === "error") {
    const message = asString(rec.message, "Unknown error");
    console.log(pc.red(`[ollama] error: ${message}`));
    return;
  }

  if (debug) {
    console.log(pc.gray(trimmed));
  }
}
