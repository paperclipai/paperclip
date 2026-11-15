import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";

export const MIN_SECRET_OUTPUT_VALUE_LENGTH = 8;
const MIN_RESUMED_SUFFIX_LENGTH = 4;

const PROTOCOL_KEY = /^(?:id|ids|ref|refs|schema|type|kind|status|state|outcome|phase|stream|channel|role|level|color|transport|operation|namespace|provider|model|biller|disposition|priority|mode|method)$|(?:Id|Ids|Ref|Refs|Type|Kind|State|Status|Code|Disposition|Revision|Version|Mode|Schema|Digest|Sha256|At)$|_(?:id|ids|type|kind|state|status|code)$/;

export function secretEnvironmentValues(env: unknown, secretKeys: Iterable<string>): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const record = env as Record<string, unknown>;
  return [...new Set([...secretKeys].map(key => record[key]).filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function secretOutputForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of secrets) {
    const lines = /[\r\n]/.test(value) ? value.split(/\r?\n|\r/).map(line => line.trim()).filter(line => !line.startsWith("-----")) : [];
    for (const form of [value, value.trim(), ...lines]) {
      if (form.trim().length < MIN_SECRET_OUTPUT_VALUE_LENGTH) continue;
      forms.add(form);
      forms.add(JSON.stringify(form).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function replaceValues(text: string, values: readonly string[]): string {
  return values.reduce((result, value) => result.split(value).join(REDACTED_EVENT_VALUE), text);
}

function resumedSuffixLength(text: string, candidates: readonly string[]): number {
  let longest = 0;
  for (const value of candidates) {
    for (let size = value.length - 1; size >= MIN_RESUMED_SUFFIX_LENGTH && size > longest; size--) {
      const suffix = value.slice(-size);
      if (text.startsWith(suffix)) { longest = size; break; }
      if (text.length >= MIN_RESUMED_SUFFIX_LENGTH && text.length > longest && suffix.startsWith(text)) { longest = text.length; break; }
    }
  }
  return longest;
}

function redactOutputSecretValues<T>(input: T, values: readonly string[], key?: string): T {
  if (values.length === 0 || (key !== undefined && PROTOCOL_KEY.test(key))) return input;
  if (typeof input === "string") return replaceValues(input, values) as T;
  if (Array.isArray(input)) return input.map((entry) => redactOutputSecretValues(entry, values, key)) as T;
  if (!input || typeof input !== "object" || input instanceof Date) return input;
  return Object.fromEntries(Object.entries(input).map(([entryKey, entry]) =>
    [entryKey, redactOutputSecretValues(entry, values, entryKey)])) as T;
}

/** Keep private material in memory only; do not copy it into run snapshots. */
export function createAgentIdentityRedactor(privateKeyPem?: string, secrets: readonly string[] = [],
  options: { maskResumedSuffixes?: boolean } = {}) {
  const values = privateKeyPem ? [...new Set([
    privateKeyPem,
    privateKeyPem.trim(),
    JSON.stringify(privateKeyPem).slice(1, -1),
    ...privateKeyPem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")),
  ])].sort((a, b) => b.length - a.length) : [];
  const secretSources: string[] = [];
  const secretValues: string[] = [];
  const pending = new Map<string, string>();
  const seenStreams = new Set<string>();
  const maskedPending = new Map<string, number>();
  const deltaStreams = new Map<string, {
    scope: string; itemId?: string; payload: Record<string, unknown>; paths: string[];
  }>();
  const redactor = {
    values,
    secretSources,
    secretValues,
    addSecretValues(secrets: readonly string[]) {
      secretSources.splice(0, secretSources.length, ...new Set([...secretSources, ...secrets.filter(Boolean)]));
      secretValues.splice(0, secretValues.length, ...secretOutputForms(secretSources));
    },
    redact<T>(value: T, key?: string): T {
      return redactOutputSecretValues(redactRegisteredSecretValues(value, values), secretValues, key);
    },
    // Hold only a suffix that could begin a secret. Separate buffers prevent
    // interleaved stdout/stderr from defeating matching across output chunks.
    chunk(stream: string, chunk: string): string {
      const text = (pending.get(stream) ?? "") + chunk;
      const candidates = [...values, ...secretValues].sort((a, b) => b.length - a.length);
      const resumes = options.maskResumedSuffixes === true && !seenStreams.has(stream);
      const resumed = Math.max(resumes ? resumedSuffixLength(text, candidates) : 0, maskedPending.get(stream) ?? 0);
      if (resumes && resumed === 0 && text.length > 0 && text.length < MIN_RESUMED_SUFFIX_LENGTH
        && candidates.some((value) => value.indexOf(text, 1) !== -1)) {
        pending.set(stream, text);
        return "";
      }
      const masked: Array<[number, number]> = resumed > 0 ? [[0, resumed]] : [];
      let end = text.length;
      for (let index = 0; index < text.length;) {
        let matched = 0;
        let partial = false;
        for (const value of candidates) {
          if (value.charCodeAt(0) !== text.charCodeAt(index)) continue;
          if (text.startsWith(value, index)) { matched = value.length; break; }
          if (text.length - index < value.length && value.startsWith(text.slice(index))) { partial = true; break; }
        }
        if (partial) { end = index; break; }
        if (matched) {
          masked.push([index, index + matched]);
          index += matched;
        } else index++;
      }
      if (end < text.length) pending.set(stream, text.slice(end));
      else pending.delete(stream);
      if (end < Math.min(resumed, text.length)) maskedPending.set(stream, Math.min(resumed, text.length) - end);
      else maskedPending.delete(stream);
      if (resumes && end > resumed) seenStreams.add(stream);
      const merged: Array<[number, number]> = [];
      for (const [from, to] of masked.sort((left, right) => left[0] - right[0])) {
        const last = merged.at(-1);
        if (last && from < last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
      }
      let output = "";
      let cursor = 0;
      for (const [from, to] of merged) {
        if (from >= end) break;
        output += text.slice(cursor, from) + REDACTED_EVENT_VALUE;
        cursor = Math.min(to, end);
      }
      return output + text.slice(cursor, end);
    },
    // An interrupted partial secret must not be flushed as plaintext.
    finish(stream: string): string {
      const held = pending.get(stream);
      const heldMasked = maskedPending.has(stream);
      pending.delete(stream);
      maskedPending.delete(stream);
      if (held && heldMasked) return REDACTED_EVENT_VALUE;
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
          if (!/^(text|delta|output|patch)$/.test(field)) return redactor.redact(entry, field || undefined);
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
          .filter(key => typeof payload[key] === "string").map(key => [key, redactor.redact(payload[key], key)])),
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
  redactor.addSecretValues(secrets);
  return redactor;
}
