import { constants } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { diagnosticSecrets, readPrivateDiagnosticSecrets } from "./private-diagnostics.js";
import { findSecretLeak, redactText } from "./redaction.js";

export const HEALTH_DETAIL_ID = "chat-setup-health.runner-opencode.local.setup-only";
export const HEALTH_DETAIL_PATH = "diagnostics/setup-health-hello.jsonl";
const privateFile = (root: string) => path.join(root, "artifacts-private", "setup-health-hello.jsonl");

function scrub(value: unknown, secrets: readonly string[]) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Bounded diagnostic unavailable");
  const safe = redactText(value, secrets)
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[URL REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL REDACTED]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:[^\r\n]*/gi, "[HEADER REDACTED]");
  if (findSecretLeak(safe, secrets)) throw new Error("Diagnostic withheld");
  return safe;
}
/** Returned hello check only, never raw process output, config or caught errors. */
export async function retainHealthHelloDetail(root: string, ids: readonly string[], sequence: number, result: unknown): Promise<"retained" | "withheld" | undefined> {
  if (ids.length !== 1 || ids[0] !== HEALTH_DETAIL_ID) return undefined;
  try {
    const secrets = diagnosticSecrets(readPrivateDiagnosticSecrets(path.join(root, "selected-private-inputs", "diagnostic-redaction.json"), root)).values;
    const checks = (result as { checks?: unknown[] })?.checks;
    const failures = checks?.filter((check: any) => check?.code === "opencode_hello_probe_failed" && check.level === "error") ?? [];
    if (!failures.length) return undefined;
    const rows = failures.slice(0, 4).map((check: any) => ({ sequence, code: "opencode_hello_probe_failed", message: scrub(check.message, secrets), detail: scrub(check.detail ?? "", secrets) }));
    const file = await open(privateFile(root), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error("Diagnostic custody invalid");
      await file.writeFile(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    } finally { await file.close(); }
    return "retained";
  } catch { return "withheld"; }
}
/** Separate access-controlled Actions artifact entry; never public evidence. */
export async function copyHealthHelloDetail(root: string, executionId: string, uploadDir: string, knownSecrets: readonly string[]) {
  if (executionId !== HEALTH_DETAIL_ID) return;
  try {
    const bytes = await readFile(privateFile(root), "utf8");
    if (bytes.length > 32768 || findSecretLeak(bytes, diagnosticSecrets(knownSecrets).values)) return;
    const destination = path.join(uploadDir, HEALTH_DETAIL_PATH);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await chmod(destination, 0o600); } finally { await file.close(); }
  } catch { /* No raw detail or filesystem error enters reporters. */ }
}
