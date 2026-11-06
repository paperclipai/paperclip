import { gunzipSync, inflateRawSync } from "node:zlib";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { CompanySecret } from "../../../packages/shared/src/types/secrets.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";

const MAX_BYTES = 16 * 1024 * 1024;
/** Compare persisted identity/custody/version semantics. Resolution timestamps,
 * reference counters, serialization order and other bookkeeping are irrelevant. */
export function sameSecretIdentity(before: Partial<CompanySecret> | undefined, after: Partial<CompanySecret> | undefined) {
  if (!before || !after) return false;
  return (["id", "companyId", "scope", "ownerUserId", "userSecretDefinitionId", "key", "provider", "managedMode", "externalRef", "providerConfigId", "latestVersion", "status", "deletedAt"] as const)
    .every(key => (before[key] ?? null) === (after[key] ?? null));
}
/** Read a bounded ZIP directory and inflate entries without extracting paths or
 * executing content. Missing/encrypted/unsupported entries refuse completeness. */
function zipContents(bytes: Buffer): Buffer[] {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) if (bytes.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0) throw new Error("Incomplete archive scan");
  const count = bytes.readUInt16LE(eocd + 10); let cursor = bytes.readUInt32LE(eocd + 16); let expanded = 0;
  if (count > 1024 || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) throw new Error("Unsupported archive scan");
  const contents: Buffer[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Incomplete archive scan");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    if (flags & 1 || ![0, 8].includes(method) || uncompressed > MAX_BYTES || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Unsupported archive scan");
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + size > bytes.length) throw new Error("Incomplete archive scan");
    const content = method === 0 ? bytes.subarray(start, start + size) : inflateRawSync(bytes.subarray(start, start + size), { maxOutputLength: MAX_BYTES });
    expanded += content.length;
    if (content.length !== uncompressed || expanded > MAX_BYTES) throw new Error("Incomplete archive scan");
    contents.push(content); cursor += 46 + nameLength + extraLength + commentLength;
  }
  return contents;
}
export function bytesContainSecret(bytes: Buffer, secret: string, depth = 0): boolean {
  if (!secret || bytes.length > MAX_BYTES || depth > 3) throw new Error("Bounded private scan unavailable");
  if ([Buffer.from(secret), Buffer.from(secret, "utf16le"), Buffer.from(Buffer.from(secret).toString("base64"))].some(needle => bytes.includes(needle))) return true;
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return zipContents(bytes).some(content => bytesContainSecret(content, secret, depth + 1));
  if (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x8b1f) return bytesContainSecret(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }), secret, depth + 1);
  // Raw absence cannot clear compressed object streams or image metadata. Only
  // completely decoded text (or supported containers above) proves a clean scan.
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-" || bytes.subarray(0, 4).toString("ascii") === "GIF8"
    || bytes.subarray(0, 4).toString("ascii") === "RIFF") throw new Error("Unsupported binary payload scan");
  try {
    const utf16 = bytes.length >= 2 && (bytes.readUInt16LE(0) === 0xfeff || bytes.readUInt16BE(0) === 0xfeff);
    const encoding = utf16 ? bytes.readUInt16LE(0) === 0xfeff ? "utf-16le" : "utf-16be" : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error("Non-text payload");
    if (text.includes(secret) || text.includes(Buffer.from(secret).toString("base64"))) return true;
  } catch { throw new Error("Unsupported binary payload scan"); }
  return false;
}
/** Fetch through the actual signed-in cookie without Playwright tracing raw
 * response bytes. Only same-instance public content endpoints are admitted. */
export async function privateScanBytes(ctx: ChatCatalogContext, reference: string): Promise<Buffer> {
  const url = new URL(reference, ctx.input.api.baseURL);
  if (url.origin !== ctx.input.api.baseURL || !/^\/api\/(?:(?:attachments|assets)\/[A-Za-z0-9-]+\/content|issues\/[A-Za-z0-9-]+\/(?:comments|attachments|work-products|documents(?:\/[A-Za-z0-9_-]+(?:\/revisions)?)?)|heartbeat-runs\/[A-Za-z0-9-]+\/events)$/.test(url.pathname)) throw new Error("Private scan reference is outside the disposable content API");
  const cookies = await ctx.input.page.context().cookies(ctx.input.api.baseURL);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Origin: ctx.input.api.baseURL, Cookie: cookies.map(row => `${row.name}=${row.value}`).join("; ") } });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Private content scan failed; body withheld"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > MAX_BYTES) throw new Error("Private content scan exceeds bounds"); chunks.push(result.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function privateScanJson<T>(ctx: ChatCatalogContext, reference: string): Promise<T> {
  try { return JSON.parse((await privateScanBytes(ctx, reference)).toString("utf8")) as T; }
  catch { throw new Error("Private JSON scan failed; contents withheld"); }
}
export async function scanReachableSecretOutputs(ctx: ChatCatalogContext, issueIds: string[], secret: string): Promise<{ complete: boolean; leaked: boolean; documents: number; attachments: number; artifacts: number }> {
  let leaked = false; let documents = 0; let attachments = 0; let artifacts = 0;
  const seen = new Set<string>();
  const scan = (bytes: Buffer) => { leaked = bytesContainSecret(bytes, secret) || leaked; };
  const scanUrl = async (reference: string) => { if (!seen.has(reference)) { seen.add(reference); scan(await privateScanBytes(ctx, reference)); artifacts++; } };
  const scanJson = (value: unknown) => scan(Buffer.from(JSON.stringify(value)));
  for (const issueId of issueIds) {
    const [comments, summaries, products, files] = await Promise.all([
      privateScanJson<Array<{ body?: string }>>(ctx, `/api/issues/${issueId}/comments?order=asc`),
      privateScanJson<Array<{ key: string }>>(ctx, `/api/issues/${issueId}/documents`),
      privateScanJson<IssueWorkProduct[]>(ctx, `/api/issues/${issueId}/work-products`), privateScanJson<IssueAttachment[]>(ctx, `/api/issues/${issueId}/attachments`),
    ]);
    scanJson([comments, products, files]);
    const references: unknown[] = [...comments, ...products];
    for (const summary of summaries) {
      const base = `/api/issues/${issueId}/documents/${encodeURIComponent(summary.key)}`;
      const [document, revisions] = await Promise.all([privateScanJson(ctx, base), privateScanJson(ctx, `${base}/revisions`)]);
      scanJson([document, revisions]); references.push(document, revisions); documents++;
    }
    for (const file of files) {
      if (file.companyId !== ctx.input.fixtures.company.id || file.issueId !== issueId) throw new Error("Private scan attachment scope differs from the task");
      await scanUrl(file.contentPath); attachments++;
    }
    for (const product of products) {
      if (product.companyId !== ctx.input.fixtures.company.id || product.issueId !== issueId) throw new Error("Private scan artifact scope differs from the task");
      if (product.type !== "artifact") continue;
      const metadata = product.metadata ?? {};
      const ref = metadata.resourceRef as { kind?: string; relativePath?: string } | undefined;
      if (ref?.kind === "workspace_file") {
        if (!ref.relativePath || path.isAbsolute(ref.relativePath)) throw new Error("Private workspace artifact scan has no bounded path");
        const base = await realpath(ctx.input.workspacePath); const file = await realpath(path.resolve(base, ref.relativePath));
        if (!file.startsWith(base + path.sep)) throw new Error("Private artifact path escapes the disposable workspace");
        const info = await stat(file); if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Bounded private workspace artifact scan unavailable");
        scan(await readFile(file)); artifacts++;
      } else {
        const contentPath = typeof metadata.contentPath === "string" ? metadata.contentPath : product.url;
        if (!contentPath) throw new Error("Reachable artifact has no content reference for private scan");
        await scanUrl(contentPath);
      }
    }
    // Tool-result assets and rendered document links can be reachable without a
    // work-product row. Discover their public content paths in persisted data.
    for (const match of JSON.stringify(references).matchAll(/\/api\/(?:attachments|assets)\/[A-Za-z0-9-]+\/content/g)) await scanUrl(match[0]);
  }
  return { complete: true, leaked, documents, attachments, artifacts };
}
