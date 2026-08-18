import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function readTextParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const texts: string[] = [];
  for (const partRaw of parts) {
    const part = parseObject(partRaw);
    const text = asString(part.text, "").trim();
    if (text) texts.push(text);
  }
  return texts;
}

function asErrorText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.trim();
  if (depth >= 3) return "";
  const record = parseObject(value);
  for (const key of ["message", "detail", "reason", "description", "code", "error", "exception", "cause"]) {
    const text = asErrorText(record[key], depth + 1);
    if (text) return text;
  }
  return "";
}

export function parseGoogleAdkJsonl(stdout: string) {
  let lastAssistantText = "";
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const toolResults: Array<{ name: string; output: unknown }> = [];
  const compactToolCalls = new Map<string, { name: string; input: unknown }>();
  const compactToolResults = new Map<string, { name: string; output: unknown }>();
  let finalResult: Record<string, unknown> = {};
  let errorMessage: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseJson(line);
    if (!parsed) continue;

    const compactEvent = asString(parsed.event, "");
    const compactDetails = parseObject(parsed.details);
    if (compactEvent === "run.completed") {
      const result = parseObject(parsed.result);
      if (Object.keys(result).length > 0) finalResult = result;
    }
    const compactSources = Array.isArray(compactDetails.sources)
      ? compactDetails.sources.flatMap((source) => {
          const name = asString(source, "").trim();
          return name ? [name] : [];
        })
      : [];
    if (compactEvent === "source_grounding.started") {
      const input = Object.fromEntries(
        Object.entries(compactDetails).filter(([key]) => !["sources", "outcome", "outcomes"].includes(key)),
      );
      for (const source of compactSources) {
        compactToolCalls.set(source, { name: source, input });
      }
    }
    if (compactEvent === "source_grounding.finished") {
      const outcome = parseObject(compactDetails.outcome);
      if (Object.keys(outcome).length > 0) {
        for (const source of compactSources) {
          compactToolResults.set(source, { name: source, output: outcome });
        }
      }
    }
    if (compactEvent === "source_grounding.completed") {
      const outcomes = parseObject(compactDetails.outcomes);
      for (const [source, output] of Object.entries(outcomes)) {
        compactToolResults.set(source, { name: source, output });
        if (!compactToolCalls.has(source)) {
          const outcome = parseObject(output);
          compactToolCalls.set(source, {
            name: source,
            input: Object.prototype.hasOwnProperty.call(outcome, "query")
              ? { query: outcome.query }
              : {},
          });
        }
      }
    }

    const content = parseObject(parsed.content);
    const role = asString(content.role, "");
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const modelTexts: string[] = [];

    for (const partRaw of parts) {
      const part = parseObject(partRaw);
      const text = asString(part.text, "").trim();
      if (text && role === "model") {
        modelTexts.push(text);
      }

      const functionCall = parseObject(part.functionCall);
      if (Object.keys(functionCall).length > 0) {
        toolCalls.push({
          name: asString(functionCall.name, "tool"),
          input: functionCall.args ?? {},
        });
      }

      const functionResponse = parseObject(part.functionResponse);
      if (Object.keys(functionResponse).length > 0) {
        toolResults.push({
          name: asString(functionResponse.name, "tool"),
          output: functionResponse.response ?? functionResponse,
        });
      }
    }

    if (role === "model" && modelTexts.length > 0) {
      lastAssistantText = modelTexts.join("\n\n").trim();
    }

    const explicitError = asErrorText(parsed.error);
    if (explicitError) errorMessage = explicitError;
    if (asString(parsed.event, "") === "run.failed") {
      const eventError = asErrorText(
        parsed.message ?? parsed.detail ?? parsed.error ?? parsed.details ?? parsed.reason ?? parsed.exception,
      );
      errorMessage = eventError || errorMessage || "Workflow reported run.failed";
    }

    const usageRaw = parseObject(parsed.usageMetadata ?? parsed.usage);
    usage = {
      inputTokens:
        usage.inputTokens +
        asNumber(usageRaw.inputTokens, asNumber(usageRaw.input_tokens, asNumber(usageRaw.promptTokenCount, 0))),
      outputTokens:
        usage.outputTokens +
        asNumber(usageRaw.outputTokens, asNumber(usageRaw.output_tokens, asNumber(usageRaw.candidatesTokenCount, 0))),
      cachedInputTokens:
        usage.cachedInputTokens +
        asNumber(
          usageRaw.cachedInputTokens,
          asNumber(usageRaw.cached_input_tokens, asNumber(usageRaw.cachedContentTokenCount, 0)),
        ),
    };
  }

  return {
    summary: lastAssistantText,
    toolCalls: [...toolCalls, ...compactToolCalls.values()],
    toolResults: [...toolResults, ...compactToolResults.values()],
    finalResult,
    usage,
    errorMessage,
  };
}

export function detectGoogleAdkAuthError(stdout: string, stderr: string): boolean {
  return /auth|authenticate|api[_ -]?key|google_api_key|permission denied|unauthorized|forbidden/i.test(
    `${stdout}\n${stderr}`,
  );
}
