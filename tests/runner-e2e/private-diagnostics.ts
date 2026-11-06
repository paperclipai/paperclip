import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findSecretLeak, normalizedSecrets, redactText } from "./redaction.js";
export const PRIVATE_DIAGNOSTICS_ENV = "PAPERCLIP_RUNNER_E2E_PRIVATE_DIAGNOSTICS";
interface Envelope { version: 1; executionIds: string[]; secrets: string[] }
function checkedPath(filename: string, temporaryRoot: string) {
  const parent = path.join(temporaryRoot, "selected-private-inputs");
  if (filename !== path.join(parent, "diagnostic-redaction.json") || realpathSync(parent) !== parent) throw new Error("Invalid private diagnostic registry path");
  const directory = lstatSync(parent); const file = lstatSync(filename);
  if (!directory.isDirectory() || directory.mode & 0o077 || file.isSymbolicLink() || !file.isFile() || file.mode & 0o077 || file.size > 4 * 1024 * 1024
    || typeof process.getuid === "function" && (directory.uid !== process.getuid() || file.uid !== process.getuid())) throw new Error("Private diagnostic registry ownership or permissions are invalid");
}
function read(filename: string, temporaryRoot: string): Envelope {
  checkedPath(filename, temporaryRoot);
  const value = JSON.parse(readFileSync(filename, "utf8")) as Envelope;
  if (value.version !== 1 || !Array.isArray(value.executionIds) || !value.executionIds.every(id => typeof id === "string") || !Array.isArray(value.secrets) || !value.secrets.every(secret => typeof secret === "string")) throw new Error("Invalid private diagnostic registry");
  return value;
}
export function stagePrivateDiagnostics(temporaryRoot: string, executionIds: string[], secrets: readonly string[]) {
  const filename = path.join(temporaryRoot, "selected-private-inputs", "diagnostic-redaction.json");
  writeFileSync(filename, JSON.stringify({ version: 1, executionIds, secrets: normalizedSecrets(secrets) } satisfies Envelope), { mode: 0o600, flag: "wx" });
  checkedPath(filename, temporaryRoot); return filename;
}
export function readPrivateDiagnosticSecrets(filename: string, temporaryRoot: string) { return read(filename, temporaryRoot).secrets; }
/** Existing case code continues to push into its private redaction sink. Each
 * registration is durable before the subsequent instrumented operation starts;
 * only the launcher/test host receives this private path, never the product. */
export function trackedPrivateSecrets(initial: string[], executionId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const filename = env[PRIVATE_DIAGNOSTICS_ENV]; if (!filename) return initial;
  const temporaryRoot = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!temporaryRoot) throw new Error("Private diagnostic registry requires an owned temporary root");
  const previous = read(filename, temporaryRoot);
  if (!previous.executionIds.includes(executionId)) throw new Error("Private diagnostic registry execution mismatch");
  const persist = (values: string[]) => {
    const current = read(filename, temporaryRoot);
    const temporary = `${filename}.${process.pid}.next`;
    writeFileSync(temporary, JSON.stringify({ ...current, secrets: normalizedSecrets([...current.secrets, ...values]) }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  };
  persist(initial);
  return new Proxy(initial, { set(target, property, value) {
    if (property !== "length" && typeof value !== "string") throw new Error("Private diagnostic secret registration must be a string");
    const next = [...target]; Reflect.set(next, property, value); persist(next);
    return Reflect.set(target, property, value);
  } });
}
export interface DiagnosticSecretExpansion {
  readonly kind: "expanded-private-diagnostic-secrets";
  readonly values: readonly string[];
}
// Provenance is process-local. Never infer raw-root status from credential bytes:
// independently registered roots can legitimately equal another root's encoding.
const rawDiagnosticRoots = new WeakMap<DiagnosticSecretExpansion, readonly string[]>();
export function diagnosticSecrets(input: readonly string[] | DiagnosticSecretExpansion): DiagnosticSecretExpansion {
  if (!Array.isArray(input)) {
    const expanded = input as DiagnosticSecretExpansion;
    if (!rawDiagnosticRoots.has(expanded)) throw new Error("Diagnostic expansion has no raw-root provenance");
    return expanded;
  }
  const roots = normalizedSecrets(input);
  const variants = roots.flatMap(value => {
    let structured = false; try { const parsed = JSON.parse(value); structured = parsed !== null && typeof parsed === "object"; } catch { /* Ordinary secret. */ }
    return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"),
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
      ...value.split(/\r?\n/).filter(line => structured ? line.length >= 8 : line.length > 0)];
  });
  const expanded: DiagnosticSecretExpansion = Object.freeze({ kind: "expanded-private-diagnostic-secrets", values: Object.freeze(normalizedSecrets(variants)) });
  rawDiagnosticRoots.set(expanded, Object.freeze(roots));
  return expanded;
}

/** No raw byte reaches a console or log. UTF-8 and secret boundaries may span
 * chunks. Oversized unterminated lines are withheld whole, with a truthful
 * omission marker; arbitrary memory growth never forces an unsafe flush. */
export function createPrivateDiagnosticStream(secrets: () => readonly string[], emit: (safe: string) => void, maximumLine = 1024 * 1024) {
  const decoder = new StringDecoder("utf8"); let pending = ""; let suppressing = false; let failed = false; let ended = false; let leaked = false;
  const line = (value: string) => {
    try { const values = diagnosticSecrets(secrets()).values; leaked ||= !!findSecretLeak(value, values); emit(redactText(value, values)); }
    catch { failed = true; emit("[diagnostics withheld: private redaction unavailable]\n"); }
  };
  const consume = (text: string) => {
    for (const fragment of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (!suppressing) pending += fragment;
      if (pending.length > maximumLine) { pending = ""; suppressing = true; emit("[diagnostic line withheld: size bound exceeded]\n"); }
      if (fragment.endsWith("\n")) { if (!suppressing) line(pending); pending = ""; suppressing = false; }
    }
  };
  return { write(chunk: Buffer) { if (!ended) consume(decoder.write(chunk)); }, end() { if (ended) return; ended = true; consume(decoder.end()); if (pending && !suppressing) line(pending); pending = ""; }, failed() { return failed; }, redactedSecret() { return leaked; } };
}
