import { constants } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSecretFree, findSecretLeak, findSecretLeakInJsonValues, normalizedSecrets, sanitizeJson } from "./redaction.js";

export const PRIVATE_FRAMEWORK_ORIGINAL_REPORT = "snapshots/playwright-framework-original.txt";
export const PRIVATE_FRAMEWORK_REPORT = "snapshots/playwright-framework.json";
const producerVersion: string = createRequire(import.meta.url)("@playwright/test/package.json").version;
const LIMIT = 256 * 1024 * 1024;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const fail = (): never => { throw new Error("Invalid private framework evidence"); };
type Row = { path: string; bytes: number; sha256: string };
type FrameworkReport = { schema: string; sourceReportSha256: string; report: Record<string, unknown>; attachments: Row[]; canonicalExecutionId?: string };
async function regular(root: string, relative: string, limit = LIMIT) {
  if (!relative || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f:]/.test(relative)) fail();
  let current = root;
  for (const part of relative.split("/")) { current = path.join(current, part); const entry = await lstat(current); if (entry.isSymbolicLink()) fail(); }
  const info = await lstat(current);
  if (!info.isFile() || info.size > limit || !(await realpath(current)).startsWith(`${await realpath(root)}${path.sep}`)) fail();
  const data = await readFile(current), after = await lstat(current);
  if (data.length !== info.size || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail();
  return data;
}
function results(report: Record<string, unknown>) {
  if (!report.config || typeof report.config !== "object" || !Array.isArray(report.suites) || !report.suites.length || !Array.isArray(report.errors)) fail();
  if ((report.config as Record<string, unknown>).version !== producerVersion) fail();
  const found: Array<Record<string, unknown>> = []; let visited = 0;
  const suite = (value: any) => {
    if (++visited > 4096 || !value || (value.specs !== undefined && !Array.isArray(value.specs)) || (value.suites !== undefined && !Array.isArray(value.suites))) fail();
    for (const spec of value.specs ?? []) {
      if (!spec || !Array.isArray(spec.tests) || !spec.tests.length) fail();
      for (const test of spec.tests) {
        if (!test || !Array.isArray(test.results) || !test.results.length) fail();
        for (const result of test.results) {
          if (++visited > 4096 || !result || !["passed", "failed", "timedOut", "skipped", "interrupted"].includes(result.status)
            || !Array.isArray(result.attachments) || !Array.isArray(result.errors) || !Array.isArray(result.stdout) || !Array.isArray(result.stderr)) fail();
          found.push(result);
        }
      }
    }
    for (const child of value.suites ?? []) suite(child);
  };
  for (const value of report.suites as unknown[]) suite(value);
  if (!found.length) fail();
  return found;
}
export function inspectPrivateFrameworkMetadata(relative: string, raw: string, secrets: readonly string[]) {
  const original = relative === PRIVATE_FRAMEWORK_ORIGINAL_REPORT || relative.endsWith(`/${PRIVATE_FRAMEWORK_ORIGINAL_REPORT}`) || relative === "framework-report.json";
  const sidecar = relative === PRIVATE_FRAMEWORK_REPORT || relative.endsWith(`/${PRIVATE_FRAMEWORK_REPORT}`);
  if (!original && !sidecar) return false;
  if (Buffer.byteLength(raw) > 128 * 1024 * 1024) fail();
  const parsed = JSON.parse(raw), report = original ? parsed : parsed.report;
  const expanded = normalizedSecrets(secrets).flatMap(v => [v, encodeURIComponent(v), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")]);
  if (findSecretLeakInJsonValues(parsed, expanded) || JSON.stringify(sanitizeJson(parsed, secrets)) !== JSON.stringify(parsed)) fail();
  for (const result of results(report)) for (const attachment of result.attachments as any[]) {
    if (!attachment || typeof attachment.name !== "string" || typeof attachment.contentType !== "string") fail();
    if (attachment.body !== undefined) {
      if (typeof attachment.body !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.body)) fail();
      const body = Buffer.from(attachment.body, "base64"), text = body.toString("utf8");
      if (!["text/plain", "application/json"].includes(attachment.contentType) || !Buffer.from(text).equals(body) || findSecretLeak(body, expanded)) fail();
      if (attachment.contentType === "application/json" && (findSecretLeak(JSON.stringify(JSON.parse(text)), expanded) || JSON.stringify(sanitizeJson(JSON.parse(text), secrets)) !== JSON.stringify(JSON.parse(text)))) fail();
    }
  }
  return true;
}
export async function copyPrivateFrameworkReport(source: string, destination: string, secrets: readonly string[]) {
  const raw = await regular(source, "framework-report.json", 128 * 1024 * 1024);
  if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail();
  assertSecretFree(raw.toString("utf8"), secrets, "private framework metadata");
  const report = JSON.parse(raw.toString("utf8"));
  const attachments = new Map<string, Row>();
  inspectPrivateFrameworkMetadata("framework-report.json", raw.toString("utf8"), secrets);
  for (const result of results(report)) for (const attachment of result.attachments as any[]) {
    if (!attachment || typeof attachment.name !== "string" || typeof attachment.contentType !== "string") fail();
    if (attachment.path === undefined) { if (attachment.body === undefined) fail(); continue; }
    if (typeof attachment.path !== "string" || !path.isAbsolute(attachment.path)) fail();
    const absolute = path.resolve(attachment.path), output = path.join(source, "playwright-output");
    let relative: string;
    if (absolute.startsWith(`${path.resolve(destination)}${path.sep}`)) relative = path.relative(destination, absolute);
    else if (absolute.startsWith(`${path.resolve(output)}${path.sep}`)) relative = path.relative(source, absolute);
    else fail();
    relative = relative!.split(path.sep).join("/");
    const data = await regular(absolute.startsWith(`${path.resolve(destination)}${path.sep}`) ? destination : source, relative);
    if (relative === "result.json") {
      relative = "snapshots/playwright-attached-result.json";
      await mkdir(path.dirname(path.join(destination, relative)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(destination, relative), data, { flag: "wx", mode: 0o600 });
    } else {
      const copied = await regular(destination, relative);
      if (!copied.equals(data)) fail();
    }
    attachment.path = relative;
    const row = { path: relative, bytes: data.length, sha256: hash(data) };
    const previous = attachments.get(relative); if (previous && JSON.stringify(previous) !== JSON.stringify(row)) fail();
    attachments.set(relative, row);
  }
  const sidecar: FrameworkReport = { schema: "paperclip.private-framework-json/v1", sourceReportSha256: hash(raw), report,
    attachments: [...attachments.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  await mkdir(path.join(destination, "snapshots"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(destination, PRIVATE_FRAMEWORK_ORIGINAL_REPORT), raw, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(destination, PRIVATE_FRAMEWORK_REPORT), `${JSON.stringify(sidecar)}\n`, { flag: "wx", mode: 0o600 });
}
export async function validatePrivateFrameworkReport(directory: string, canonical = directory, executionId?: string) {
  const raw = await regular(directory, PRIVATE_FRAMEWORK_REPORT, 128 * 1024 * 1024);
  const value = JSON.parse(raw.toString("utf8")) as FrameworkReport;
  const keys = Object.keys(value).sort().join();
  if (keys !== (executionId ? "attachments,canonicalExecutionId,report,schema,sourceReportSha256" : "attachments,report,schema,sourceReportSha256")
    || value.schema !== "paperclip.private-framework-json/v1" || !/^[0-9a-f]{64}$/.test(value.sourceReportSha256)
    || executionId && value.canonicalExecutionId !== executionId || !Array.isArray(value.attachments) || value.attachments.length > 4096) fail();
  if (executionId) {
    const original = await validatePrivateFrameworkReport(canonical);
    const { canonicalExecutionId: _, ...retained } = value;
    if (JSON.stringify(retained) !== JSON.stringify(original)) fail();
  }
  const originalRaw = await regular(directory, PRIVATE_FRAMEWORK_ORIGINAL_REPORT, 128 * 1024 * 1024);
  if (hash(originalRaw) !== value.sourceReportSha256) fail();
  inspectPrivateFrameworkMetadata(PRIVATE_FRAMEWORK_ORIGINAL_REPORT, originalRaw.toString("utf8"), []);
  const authoritative = JSON.parse(originalRaw.toString("utf8"));
  const originalResults = results(authoritative), retainedResults = results(value.report);
  if (originalResults.length !== retainedResults.length) fail();
  for (let i = 0; i < originalResults.length; i++) {
    const originalAttachments = originalResults[i]!.attachments as any[], retainedAttachments = retainedResults[i]!.attachments as any[];
    if (originalAttachments.length !== retainedAttachments.length) fail();
    for (let j = 0; j < originalAttachments.length; j++) {
      if (originalAttachments[j].path !== undefined) originalAttachments[j].path = retainedAttachments[j].path;
    }
  }
  if (JSON.stringify(authoritative) !== JSON.stringify(value.report)) fail();
  const referenced = new Set<string>();
  for (const result of results(value.report)) for (const attachment of result.attachments as any[]) {
    if (attachment.path !== undefined) { if (typeof attachment.path !== "string") fail(); referenced.add(attachment.path); }
  }
  const seen = new Set<string>(); let attachmentBytes = 0;
  for (const row of value.attachments) {
    if (!row || Object.keys(row).sort().join() !== "bytes,path,sha256" || !referenced.has(row.path) || seen.has(row.path)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)) fail();
    attachmentBytes += row.bytes; if (attachmentBytes > LIMIT) fail();
    const data = await regular(canonical, row.path); if (data.length !== row.bytes || hash(data) !== row.sha256) fail();
    seen.add(row.path);
  }
  if (seen.size !== referenced.size) fail();
  return value;
}
export async function referenceSealedFrameworkAttachments(directory: string, original: string, executionId: string) {
  const value = await validatePrivateFrameworkReport(directory);
  const sealed = await validatePrivateFrameworkReport(original);
  if (JSON.stringify(value) !== JSON.stringify(sealed)) fail();
  for (const row of value.attachments.filter(r => r.path.startsWith("playwright-output/"))) {
    const current = await regular(directory, row.path), canonical = await regular(original, row.path);
    if (!current.equals(canonical)) fail();
    await rm(path.join(directory, row.path));
  }
  value.canonicalExecutionId = executionId;
  await writeFile(path.join(directory, PRIVATE_FRAMEWORK_REPORT), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function materializePrivateFrameworkAttachments(directory: string, original: string, executionId: string) {
  const value = await validatePrivateFrameworkReport(directory, original, executionId);
  let bytes = 0;
  for (const row of value.attachments) {
    bytes += row.bytes; if (bytes > LIMIT) fail();
    if (!row.path.startsWith("playwright-output/")) continue;
    const source = await regular(original, row.path);
    if (source.length !== row.bytes || hash(source) !== row.sha256) fail();
    await mkdir(path.dirname(path.join(directory, row.path)), { recursive: true, mode: 0o700 });
    await copyFile(path.join(original, row.path), path.join(directory, row.path), constants.COPYFILE_EXCL);
    const restored = await regular(directory, row.path);
    if (hash(restored) !== row.sha256) fail();
  }
}
