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

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = parseObject(value);
  return (
    asString(record.message, "").trim() ||
    asString(record.error, "").trim() ||
    asString(record.detail, "").trim() ||
    asString(record.code, "").trim()
  );
}

export function parseGoogleAdkJsonl(stdout: string) {
  let lastAssistantText = "";
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const toolResults: Array<{ name: string; output: unknown }> = [];
  let errorMessage: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseJson(line);
    if (!parsed) continue;

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

    const explicitError = asErrorText(parsed.error ?? parsed.message ?? parsed.detail);
    if (explicitError) errorMessage = explicitError;

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
    toolCalls,
    toolResults,
    usage,
    errorMessage,
  };
}

export function detectGoogleAdkAuthError(stdout: string, stderr: string): boolean {
  return /auth|authenticate|api[_ -]?key|google_api_key|permission denied|unauthorized|forbidden/i.test(
    `${stdout}\n${stderr}`,
  );
}
