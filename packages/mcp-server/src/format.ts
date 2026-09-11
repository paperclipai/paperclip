import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

const SENSITIVE_FIELD_NAMES = new Set([
  "token",
  "authtoken",
  "deviceprivatekeypem",
  "apikey",
  "secret",
  "password",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactSensitiveFields(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      redacted[key] = "***REDACTED***";
    } else {
      redacted[key] = redactSensitiveFields(fieldValue);
    }
  }
  return redacted;
}

export function formatTextResponse(value: unknown): McpTextResponse {
  const redacted = redactSensitiveFields(value);
  return {
    content: [
      {
        type: "text",
        text: typeof redacted === "string" ? redacted : JSON.stringify(redacted, null, 2),
      },
    ],
  };
}

export function formatErrorResponse(error: unknown): McpTextResponse {
  if (error instanceof PaperclipApiError) {
    return formatTextResponse({
      error: error.message,
      status: error.status,
      method: error.method,
      path: error.path,
      body: error.body,
    });
  }
  return formatTextResponse({
    error: error instanceof Error ? error.message : String(error),
  });
}
