export interface ProviderFailure {
  schema: "paperclip.provider-failure.v1";
  provider: string;
  phase: "startup" | "turn";
  category: "rate_limit" | "quota_exhausted" | "authentication" | "permission" | "model_unavailable" | "invalid_request" | "overloaded" | "timeout" | "unknown";
  message: string;
  providerCode?: string;
  httpStatus?: number;
  requestId?: string;
  retryAt?: string;
  retryability: "transient" | "requires_action" | "unknown";
}

const fields = {
  "schema": {
    "const": "paperclip.provider-failure.v1"
  },
  "provider": {
    "type": "string",
    "minLength": 1,
    "maxLength": 80,
    "pattern": "^[a-zA-Z0-9_.:/-]+$"
  },
  "phase": {
    "enum": [
      "startup",
      "turn"
    ]
  },
  "category": {
    "enum": [
      "rate_limit",
      "quota_exhausted",
      "authentication",
      "permission",
      "model_unavailable",
      "invalid_request",
      "overloaded",
      "timeout",
      "unknown"
    ]
  },
  "message": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4000
  },
  "providerCode": {
    "type": "string",
    "minLength": 1,
    "maxLength": 160,
    "pattern": "^[a-zA-Z0-9_.:/-]+$"
  },
  "httpStatus": {
    "type": "integer",
    "minimum": 400,
    "maximum": 599
  },
  "requestId": {
    "type": "string",
    "minLength": 1,
    "maxLength": 160,
    "pattern": "^[a-zA-Z0-9_.:/-]+$"
  },
  "retryAt": {
    "type": "string",
    "format": "date-time"
  },
  "retryability": {
    "enum": [
      "transient",
      "requires_action",
      "unknown"
    ]
  }
} as const;

export function readProviderFailure(value: unknown): ProviderFailure | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      const item = input[key];
      if (item === undefined && !["schema","provider","phase","category","message","retryability"].includes(key)) continue;
      if ("const" in field) {
        if (item !== field.const) return null;
      } else if ("enum" in field) {
        if (typeof item !== "string" || !(field.enum as readonly string[]).includes(item)) return null;
      } else if (field.type === "integer") {
        if (typeof item !== "number" || !Number.isInteger(item) || item < field.minimum || item > field.maximum) return null;
      } else {
        if (typeof item !== "string") return null;
        if ("maxLength" in field && ([...item].length < field.minLength || [...item].length > field.maxLength)) return null;
        if ("pattern" in field && !new RegExp(field.pattern).test(item)) return null;
        if ("format" in field && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item)) return null;
        if ("format" in field && !Number.isFinite(Date.parse(item))) return null;
      }
      output[key] = item;
    }
    return output as unknown as ProviderFailure;
  } catch { return null; }
}
