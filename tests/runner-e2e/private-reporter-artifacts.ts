import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectEmbeddedReport, inspectZip } from "./evidence.js";
import { diagnosticSecrets, type DiagnosticSecretExpansion } from "./private-diagnostics.js";
import { findSecretLeak, redactText, sanitizeJson } from "./redaction.js";
import { cellTraceAsset, readPrivateCellTraceAsset, type PrivateCellEvidenceOwner } from "./manual-private-report-assets.js";
export interface ReporterPrivacyIssue { file: string; disposition: "redacted" | "omitted"; reason: string }
const sources = ["server.log", "playwright.log", "junit.xml", "html-report", "blob-report", "playwright-output"];
const text = new Set([".log", ".txt", ".md", ".xml", ".html", ".json", ".js", ".css"]);
/** Only reporter/diagnostic sinks are touched, after independent product oracles
 * finish. Product API snapshots and work-product bytes are never pre-sanitized.
 * Uninspectable/leaking compressed reports are omitted rather than fabricated. */
export async function sanitizePrivateReporterArtifacts(root: string, values: readonly string[] | DiagnosticSecretExpansion,
  privateCell?: { owner: PrivateCellEvidenceOwner }): Promise<ReporterPrivacyIssue[]> {
  const secrets = diagnosticSecrets(values).values; const issues: ReporterPrivacyIssue[] = [];
  const visit = async (relative: string): Promise<void> => {
    const filename = path.join(root, relative); const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    const safeName = redactText(relative, secrets);
    if (info.isDirectory()) { for (const name of await readdir(filename)) await visit(path.join(relative, name)); return; }
    if (privateCell && cellTraceAsset(relative, privateCell.owner, "original").reserved) {
      // These are immutable Playwright program files. Scan and authenticate
      // them with the same guard used by packaging; diagnostic text rewriting
      // can change clean JavaScript and invalidate its producer identity.
      await readPrivateCellTraceAsset({ owner: privateCell.owner, layout: "original", relative,
        file: filename, remaining: info.size, secrets });
      return;
    }
    if (info.isSymbolicLink()) { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason: "reporter symlink cannot be inspected" }); return; }
    if (!info.isFile()) return;
    if (safeName !== relative) { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason: "credential in reporter filename" }); return; }
    const extension = path.extname(filename).toLowerCase();
    if (extension === ".zip") {
      const reason = await inspectZip(filename, secrets);
      if (reason) { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason }); }
    } else if (text.has(extension)) {
      if (info.size > 128 * 1024 * 1024) { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason: "reporter text exceeds inspection bound" }); return; }
      const raw = await readFile(filename, "utf8");
      const opaque = extension === ".html" ? await inspectEmbeddedReport(raw, secrets) : null;
      if (opaque) { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason: opaque }); return; }
      const leak = findSecretLeak(raw, secrets);
      let safe: string;
      if (extension === ".json") {
        try { safe = `${JSON.stringify(sanitizeJson(JSON.parse(raw), secrets), null, 2)}\n`; }
        catch { await rm(filename); issues.push({ file: safeName, disposition: "omitted", reason: "reporter JSON could not be safely parsed" }); return; }
      } else safe = redactText(raw, secrets);
      if (safe !== raw) await writeFile(filename, safe, { mode: 0o600 });
      if (leak) issues.push({ file: safeName, disposition: "redacted", reason: leak });
    }
  };
  for (const source of sources) await visit(source);
  return issues;
}
