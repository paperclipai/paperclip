import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LinearWebhookFixture {
  name: string;
  description: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expect: {
    eventType: string;
    action: string;
    paperclipSideEffects: string[];
  };
}

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "linear-signature",
  "x-linear-signature",
  "x-signature",
]);

const SENSITIVE_KEY_RE = /(token|secret|signature|authorization|cookie|email|avatar|url|name|displayName|title|summary|description|body|content|text)$/i;

export function sanitizeLinearWebhookValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLinearWebhookValue(item));
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeLinearWebhookValue(nested);
    }
    return sanitized;
  }

  return value;
}

export function sanitizeLinearWebhookFixture(input: {
  name: string;
  description?: string;
  headers?: Record<string, unknown>;
  body: Record<string, unknown>;
  expect?: LinearWebhookFixture["expect"];
}): LinearWebhookFixture {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const headerKey = key.toLowerCase();
    headers[headerKey] = SECRET_HEADER_NAMES.has(headerKey) ? "[redacted]" : String(value);
  }

  const sanitizedBody = sanitizeLinearWebhookValue(input.body) as Record<string, unknown>;
  const action = typeof sanitizedBody.action === "string" ? sanitizedBody.action : "unknown";
  const eventType = typeof sanitizedBody.type === "string" ? sanitizedBody.type : "unknown";

  return {
    name: input.name,
    description: input.description ?? "Sanitized Linear webhook fixture",
    headers,
    body: sanitizedBody,
    expect: input.expect ?? {
      eventType,
      action,
      paperclipSideEffects: [],
    },
  };
}

export async function loadLinearWebhookFixtures(fixturesDir = defaultLinearWebhookFixturesDir()) {
  const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
  const fixturePaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(fixturesDir, entry.name))
    .sort();

  const fixtures: LinearWebhookFixture[] = [];
  for (const fixturePath of fixturePaths) {
    const raw = await fs.readFile(fixturePath, "utf8");
    fixtures.push(JSON.parse(raw) as LinearWebhookFixture);
  }
  return fixtures;
}

export function defaultLinearWebhookFixturesDir() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../__fixtures__/linear-webhooks");
}
