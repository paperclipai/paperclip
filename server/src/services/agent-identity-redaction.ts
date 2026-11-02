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
  const deltaStreams = new Map<string, {
    scope: string; itemId?: string; payload: Record<string, unknown>; paths: string[];
  }>();
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
      if (held) pending.set(stream, text.slice(-held));
      else pending.delete(stream);
      return held ? text.slice(0, -held) : text;
    },
    // An interrupted partial secret must not be flushed as plaintext.
    finish(stream: string): string {
      const held = pending.get(stream);
      pending.delete(stream);
      // Ed25519 PEM/PKCS#8 values begin with fixed structural bytes. Preserve
      // ordinary endings such as a dash; longer interrupted fragments stay hidden.
      return held ? (held.length < 8 ? held : REDACTED_EVENT_VALUE) : "";
    },
    /** Delta payloads can repeat output under text and provider-specific fields. */
    delta<T>(stream: string, value: T, itemId?: string): T {
      const scope = stream;
      const paths: string[] = [];
      const payload = value as Record<string, unknown>;
      // Durable transports can share one envelope item ID across provider items.
      stream = JSON.stringify([stream, payload.itemId, payload.providerItemId, payload.channel, payload.stream]);
      const visit = (entry: unknown, path: string, field: string): unknown => {
        if (typeof entry === "string") {
          if (!/^(text|delta|output|patch)$/.test(field)) return redactor.redact(entry);
          const key = `${stream}:${path}`;
          const output = redactor.chunk(key, entry);
          if (pending.has(key)) paths.push(key);
          return output;
        }
        if (Array.isArray(entry)) return entry.map((child, index) => visit(child, `${path}.${index}`, field));
        if (entry && typeof entry === "object") return Object.fromEntries(
          Object.entries(entry).map(([key, child]) => [key, visit(child, `${path}.${key}`, key)]),
        );
        return entry;
      };
      const result = visit(value, "", "") as T;
      for (const previous of deltaStreams.get(stream)?.paths ?? []) {
        if (pending.has(previous) && !paths.includes(previous)) paths.push(previous);
      }
      if (paths.length) deltaStreams.set(stream, { scope, itemId, paths,
        payload: Object.fromEntries(["itemId", "providerItemId", "kind", "channel", "stream"]
          .filter(key => typeof payload[key] === "string").map(key => [key, redactor.redact(payload[key])])),
      });
      else deltaStreams.delete(stream);
      return result;
    },
    /** Settle output in the terminal event, preserving its source receipt identity. */
    settleDeltas(scope: string, payload: Record<string, unknown>, wholeTurn: boolean) {
      const tails: Array<{ itemId?: string; payload: Record<string, unknown> }> = [];
      for (const [stream, descriptor] of deltaStreams) {
        if (wholeTurn ? !descriptor.scope.startsWith(scope) : descriptor.scope !== scope) continue;
        if (!wholeTurn && payload.itemId && descriptor.payload.itemId && payload.itemId !== descriptor.payload.itemId) continue;
        const primary = descriptor.paths.find(path => path === `${stream}:.text`) ?? descriptor.paths[0];
        let text = "";
        for (const path of descriptor.paths) {
          const tail = redactor.finish(path);
          if (path === primary) text = tail;
        }
        deltaStreams.delete(stream);
        if (text) tails.push({ itemId: descriptor.itemId, payload: { ...descriptor.payload, text } });
      }
      return tails.length ? { ...payload, outputTails: [
        ...(Array.isArray(payload.outputTails) ? payload.outputTails : []), ...tails,
      ] } : payload;
    },
  };
  return redactor;
}
