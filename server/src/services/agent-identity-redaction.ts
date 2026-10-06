import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";

/** Keep private material in memory only; do not copy it into run snapshots. */
export function createAgentIdentityRedactor(privateKeyPem?: string) {
  const values = privateKeyPem ? [...new Set([
    privateKeyPem,
    privateKeyPem.trim(),
    JSON.stringify(privateKeyPem).slice(1, -1),
    ...privateKeyPem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")),
  ])].sort((a, b) => b.length - a.length) : [];
  const pending = new Map<string, string>();
  const redactor = {
    values,
    redact<T>(value: T): T { return redactRegisteredSecretValues(value, values); },
    // Hold only a suffix that could begin a secret. Separate buffers prevent
    // interleaved stdout/stderr from defeating matching across output chunks.
    chunk(stream: string, chunk: string): string {
      let text = (pending.get(stream) ?? "") + chunk;
      for (const value of values) text = text.split(value).join(REDACTED_EVENT_VALUE);
      let held = 0;
      for (const value of values) {
        for (let size = Math.min(value.length - 1, text.length); size > held; size--) {
          if (text.endsWith(value.slice(0, size))) { held = size; break; }
        }
      }
      pending.set(stream, held ? text.slice(-held) : "");
      return held ? text.slice(0, -held) : text;
    },
    // An interrupted partial secret must not be flushed as plaintext.
    finish(stream: string): string {
      const held = pending.get(stream);
      pending.delete(stream);
      return held ? REDACTED_EVENT_VALUE : "";
    },
    /** Delta payloads can repeat output under text and provider-specific fields. */
    delta<T>(stream: string, value: T): T {
      const visit = (entry: unknown, path: string, field: string): unknown => {
        if (typeof entry === "string") {
          return /^(text|delta|output|patch)$/.test(field)
            ? redactor.chunk(`${stream}:${path}`, entry)
            : redactor.redact(entry);
        }
        if (Array.isArray(entry)) return entry.map((child, index) => visit(child, `${path}.${index}`, field));
        if (entry && typeof entry === "object") return Object.fromEntries(
          Object.entries(entry).map(([key, child]) => [key, visit(child, `${path}.${key}`, key)]),
        );
        return entry;
      };
      return visit(value, "", "") as T;
    },
  };
  return redactor;
}
