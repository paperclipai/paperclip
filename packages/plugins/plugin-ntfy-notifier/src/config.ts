/**
 * Strict configuration parsing for the ntfy notifier.
 *
 * Unknown keys are rejected so that a typo (for example `topik`) is reported
 * instead of being silently ignored.
 */

export interface SecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: unknown;
}

export interface NotifierTriggers {
  approvals: boolean;
  interactions: boolean;
  blockerAttention: boolean;
  /** Open board decisions (`decision.created`). */
  decisions: boolean;
}

export interface NotifierConfig {
  ntfyBaseUrl: string;
  topic: string;
  tokenSecretRef: SecretRefBinding | null;
  paperclipBaseUrl: string;
  priority: number | null;
  allowInsecureHttp: boolean;
  triggers: NotifierTriggers;
}

export type ConfigParseResult =
  | { ok: true; config: NotifierConfig }
  | { ok: false; errors: string[] };

const TOP_LEVEL_KEYS = new Set([
  "ntfyBaseUrl",
  "topic",
  "tokenSecretRef",
  "paperclipBaseUrl",
  "priority",
  "allowInsecureHttp",
  "triggers",
]);
const TRIGGER_KEYS = new Set(["approvals", "interactions", "blockerAttention", "decisions"]);
const SECRET_REF_KEYS = new Set(["type", "secretId", "version", "projectionClass", "projectionAllowlistKey"]);

/** ntfy topic names: letters, digits, `_` and `-`, at most 64 characters. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBaseUrl(
  field: string,
  value: unknown,
  allowInsecureHttp: boolean,
  errors: string[],
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    errors.push(`${field} must be an absolute URL`);
    return null;
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    errors.push(`${field} must use https (set allowInsecureHttp only for local testing)`);
    return null;
  }
  if (url.username || url.password) {
    errors.push(`${field} must not contain credentials`);
    return null;
  }
  if (url.search || url.hash) {
    errors.push(`${field} must not contain a query or fragment`);
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseSecretRef(value: unknown, errors: string[]): SecretRefBinding | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isRecord(value) || value.type !== "secret_ref" || typeof value.secretId !== "string" || value.secretId.trim() === "") {
    errors.push('tokenSecretRef must be a secret reference ({ "type": "secret_ref", "secretId": "..." })');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!SECRET_REF_KEYS.has(key)) errors.push(`tokenSecretRef has unknown key "${key}"`);
  }
  return value as unknown as SecretRefBinding;
}

function parseBoolean(field: string, value: unknown, fallback: boolean, errors: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    errors.push(`${field} must be a boolean`);
    return fallback;
  }
  return value;
}

export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["config must be an object"] };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown config key "${key}"`);
  }

  const allowInsecureHttp = parseBoolean("allowInsecureHttp", raw.allowInsecureHttp, false, errors);
  const ntfyBaseUrl = parseBaseUrl("ntfyBaseUrl", raw.ntfyBaseUrl, allowInsecureHttp, errors);
  const paperclipBaseUrl = parseBaseUrl("paperclipBaseUrl", raw.paperclipBaseUrl, allowInsecureHttp, errors);

  let topic: string | null = null;
  if (typeof raw.topic !== "string" || !TOPIC_PATTERN.test(raw.topic)) {
    errors.push("topic is required: 1-64 letters, digits, '_' or '-'");
  } else {
    topic = raw.topic;
  }

  const tokenSecretRef = parseSecretRef(raw.tokenSecretRef, errors);

  let priority: number | null = null;
  if (raw.priority !== undefined && raw.priority !== null) {
    if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority) || raw.priority < 1 || raw.priority > 5) {
      errors.push("priority must be an integer from 1 to 5");
    } else {
      priority = raw.priority;
    }
  }

  const triggers: NotifierTriggers = { approvals: true, interactions: true, blockerAttention: true, decisions: true };
  if (raw.triggers !== undefined) {
    if (!isRecord(raw.triggers)) {
      errors.push("triggers must be an object");
    } else {
      for (const key of Object.keys(raw.triggers)) {
        if (!TRIGGER_KEYS.has(key)) errors.push(`triggers has unknown key "${key}"`);
      }
      triggers.approvals = parseBoolean("triggers.approvals", raw.triggers.approvals, true, errors);
      triggers.interactions = parseBoolean("triggers.interactions", raw.triggers.interactions, true, errors);
      triggers.blockerAttention = parseBoolean("triggers.blockerAttention", raw.triggers.blockerAttention, true, errors);
      triggers.decisions = parseBoolean("triggers.decisions", raw.triggers.decisions, true, errors);
    }
  }

  if (errors.length > 0 || !ntfyBaseUrl || !paperclipBaseUrl || !topic) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: { ntfyBaseUrl, topic, tokenSecretRef, paperclipBaseUrl, priority, allowInsecureHttp, triggers },
  };
}

/** JSON Schema shown in the plugin settings form. Mirrors `parseConfig`. */
export const INSTANCE_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ntfyBaseUrl", "topic", "paperclipBaseUrl"],
  properties: {
    ntfyBaseUrl: {
      type: "string",
      title: "ntfy server base URL",
      description: "Base URL of the ntfy server, for example https://ntfy.example.com. https is required.",
    },
    topic: {
      type: "string",
      title: "ntfy topic",
      pattern: "^[A-Za-z0-9_-]{1,64}$",
    },
    tokenSecretRef: {
      type: "object",
      format: "secret-ref",
      title: "ntfy access token (secret reference)",
      description: "Paperclip secret holding an ntfy access token with publish permission on the topic. Leave empty for an open topic.",
    },
    paperclipBaseUrl: {
      type: "string",
      title: "Paperclip public base URL",
      description: "Used only to build the notification click link, for example https://paperclip.example.com.",
    },
    priority: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      title: "ntfy priority (1-5)",
    },
    allowInsecureHttp: {
      type: "boolean",
      default: false,
      title: "Allow plain http (local testing only)",
    },
    triggers: {
      type: "object",
      additionalProperties: false,
      title: "Triggers",
      properties: {
        approvals: { type: "boolean", default: true, title: "Approvals waiting for the board" },
        interactions: { type: "boolean", default: true, title: "Questions and confirmations addressed to a person" },
        blockerAttention: { type: "boolean", default: true, title: "Blocked work that needs board attention" },
        decisions: { type: "boolean", default: true, title: "Agent decisions waiting for a board response" },
      },
    },
  },
} as const;
