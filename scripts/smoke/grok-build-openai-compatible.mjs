#!/usr/bin/env node

const BASE_URL = "https://api.x.ai/v1";
const MODEL = "grok-build-0.1";
const EXPECTED = {
  ok: true,
  probe: "grok-build-openai-compatible",
};
const TIMEOUT_MS = 45_000;

function printUsage() {
  process.stdout.write(`
Usage:
  XAI_API_KEY=... pnpm smoke:grok-build-openai-compatible

Runs a synthetic, internal-only OpenAI-compatible Grok Build 0.1 smoke against:
  ${BASE_URL}/chat/completions

The script never prints XAI_API_KEY or prompt/customer data. It verifies the model
returns the expected tiny JSON object and reports status, model id, and request id
when available.
`);
}

function requireXaiApiKey() {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY is required for the Paperclip internal Grok Build smoke environment.",
    );
  }
  return apiKey;
}

function readRequestId(response) {
  return (
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("x-xai-request-id")
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`xAI returned non-JSON HTTP response with status ${response.status}.`);
  }
}

function summarizeApiError(response, data) {
  const error = typeof data?.error === "object" && data.error !== null ? data.error : null;
  const message =
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof data?.message === "string" && data.message.trim()) ||
    response.statusText ||
    "API request failed";
  const type = typeof error?.type === "string" && error.type.trim() ? ` type=${error.type.trim()}` : "";
  return `xAI API request failed: status=${response.status}${type} message=${message.slice(0, 240)}`;
}

function parseAssistantJson(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("xAI response did not include assistant text content.");
  }

  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("xAI response content was not strict JSON.");
  }
}

function assertExpectedPayload(payload) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    payload.ok !== EXPECTED.ok ||
    payload.probe !== EXPECTED.probe
  ) {
    throw new Error("xAI response JSON did not match the expected smoke payload.");
  }
}

async function runSmoke() {
  const apiKey = requireXaiApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are running a synthetic internal API smoke test. Return only strict compact JSON with no markdown.",
          },
          {
            role: "user",
            content: `Return exactly this JSON object: ${JSON.stringify(EXPECTED)}`,
          },
        ],
        temperature: 0,
        max_completion_tokens: 64,
        response_format: { type: "json_object" },
      }),
    });
    const data = await readJsonResponse(response);
    const requestId = readRequestId(response);
    if (!response.ok) {
      throw new Error(summarizeApiError(response, data));
    }

    const payload = parseAssistantJson(data);
    assertExpectedPayload(payload);

    process.stdout.write("[grok-build-openai-compatible] pass\n");
    process.stdout.write(`model: ${MODEL}\n`);
    if (typeof data?.model === "string" && data.model.trim().length > 0) {
      process.stdout.write(`responseModel: ${data.model.trim()}\n`);
    }
    if (requestId) {
      process.stdout.write(`requestId: ${requestId}\n`);
    }
    if (typeof data?.id === "string" && data.id.trim().length > 0) {
      process.stdout.write(`responseId: ${data.id.trim()}\n`);
    }
    process.stdout.write("verification: structured JSON matched expected smoke payload\n");
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`xAI API request timed out after ${TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

runSmoke().catch((err) => {
  process.stderr.write("[grok-build-openai-compatible] fail\n");
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
