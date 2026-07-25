#!/usr/bin/env node
/**
 * paperclip-backfill-attachments.mjs
 *
 * Backfill issue attachments for a Paperclip issue from a JSON manifest of
 * {path, title, summary, contentType} entries. Uploads each file via the
 * Paperclip REST API (POST /api/companies/{companyId}/issues/{issueId}/attachments)
 * and then creates an `artifact` work-product per uploaded asset so the asset
 * is rendered as a first-class deliverable on the issue.
 *
 * Use case: an agent finished a task and wrote files to its workspace, but
 * either the `paperclip-upload-artifact.sh` helper was not installed (POP-27
 * v06) or the agent skipped the upload step. The board sees zero attachments
 * and the user cannot find the deliverable. This script re-upload-and-binds
 * the artifacts that already exist on disk.
 *
 * Usage:
 *   node scripts/paperclip-backfill-attachments.mjs \
 *     --manifest /tmp/pop27-v06-backfill-manifest.json \
 *     --issue-id 28248491-2a2c-4105-b402-15a1906fc1a2 \
 *     [--dry-run] [--no-work-product]
 *
 * Env:
 *   PAPERCLIP_API_URL       (default: http://localhost:3100)
 *   PAPERCLIP_API_KEY       (agent API key — pcp_...)
 *   PAPERCLIP_COMPANY_ID    (uuid, required)
 *   PAPERCLIP_TASK_ID       (alias of issue-id)
 *   PAPERCLIP_RUN_ID        (UUID; optional x-paperclip-run-id header)
 *   PAPERCLIP_PUBLIC_URL    (default: apiBase, used for contentPath construction)
 *
 * Manifest format:
 *   [
 *     {
 *       "path": "/abs/path/to/file.mp4",
 *       "title": "Human-readable title",
 *       "summary": "One-line description shown in the work-product card",
 *       "contentType": "video/mp4"
 *     },
 *     ...
 *   ]
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const argsPositional = args._;
const manifestPath = args.manifest || argsPositional[0];
const issueId = args["issue-id"] || process.env.PAPERCLIP_TASK_ID;
const dryRun = "dry-run" in args ? true : !!args.dryRun;
const noWorkProduct = "no-work-product" in args;
const companyId = process.env.PAPERCLIP_COMPANY_ID || args["company-id"];
const apiBase = (process.env.PAPERCLIP_API_URL || "http://localhost:3100").replace(/\/$/, "");
const publicUrl = (process.env.PAPERCLIP_PUBLIC_URL || apiBase).replace(/\/$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || args["api-key"];

function fail(msg) {
  console.error(`[backfill] ${msg}`);
  process.exit(1);
}

if (!manifestPath) fail("--manifest <path> required");
if (!issueId) fail("--issue-id <uuid> or PAPERCLIP_TASK_ID required");
if (!companyId) fail("PAPERCLIP_COMPANY_ID required");
if (!apiKey) fail("PAPERCLIP_API_KEY required");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log(`[backfill] issue=${issueId} company=${companyId} files=${manifest.length} dryRun=${dryRun}`);

function attachmentContentPath(attachmentId) {
  return `/api/attachments/${attachmentId}/content`;
}

const uploadOne = async (entry) => {
  const { path: filePath, title, summary, contentType } = entry;
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const buf = fs.readFileSync(filePath);

  const form = new FormData();
  const blob = new Blob([buf], { type: contentType || "application/octet-stream" });
  form.append("file", blob, filename);

  if (title) form.append("title", title);
  if (summary) form.append("summary", summary);

  const url = `${apiBase}/api/companies/${companyId}/issues/${issueId}/attachments`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (process.env.PAPERCLIP_RUN_ID) {
    headers["x-paperclip-run-id"] = process.env.PAPERCLIP_RUN_ID;
  }

  const res = await fetch(url, { method: "POST", headers, body: form });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upload failed for ${filePath}: ${res.status} ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { filePath, bytes: stat.size, response: json };
};

const createWorkProduct = async (assetId, entry) => {
  const contentPath = attachmentContentPath(assetId);
  const openPath = contentPath;
  const downloadPath = `${contentPath}?download=1`;
  const body = {
    type: "artifact",
    provider: "paperclip-attachment",
    externalId: assetId,
    title: entry.title || path.basename(entry.path),
    url: `${publicUrl}${openPath}`,
    status: "active",
    reviewState: "none",
    summary: entry.summary || "",
    metadata: {
      attachmentId: assetId,
      contentType: entry.contentType || "application/octet-stream",
      byteSize: entry._bytes,
      contentPath,
      openPath,
      downloadPath,
      originalFilename: path.basename(entry.path),
    },
  };
  const url = `${apiBase}/api/issues/${issueId}/work-products`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`work-product create failed for ${assetId}: ${res.status} ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return json;
};

const main = async () => {
  const uploaded = [];
  for (const entry of manifest) {
    if (dryRun) {
      const stat = fs.existsSync(entry.path) ? fs.statSync(entry.path).size : -1;
      console.log(`[backfill] (dry-run) would upload ${entry.path} (${stat} bytes, ${entry.contentType})`);
      continue;
    }
    try {
      const r = await uploadOne(entry);
      const assetId = r.response?.id || r.response?.assetId;
      console.log(`[backfill] uploaded ${path.basename(r.filePath)} (${r.bytes} bytes) -> asset ${assetId}`);
      uploaded.push({ assetId, bytes: r.bytes, entry });
    } catch (err) {
      console.error(`paperclip-backfill-attachments: ${err.message}`);
      process.exit(2);
    }
  }

  if (noWorkProduct || dryRun) {
    console.log(`[backfill] done (${uploaded.length} files).`);
    return;
  }

  let wpCount = 0;
  for (const u of uploaded) {
    if (!u.assetId) continue;
    u.entry._bytes = u.bytes;
    try {
      const wp = await createWorkProduct(u.assetId, u.entry);
      console.log(`[backfill] work-product ${u.assetId} -> ${wp.id || wp.workProductId || "?"}`);
      wpCount++;
    } catch (err) {
      console.error(`paperclip-backfill-attachments: ${err.message}`);
      process.exit(3);
    }
  }
  console.log(`[backfill] done (${uploaded.length} files, ${wpCount} work-products).`);
};

main().catch((err) => {
  console.error(`paperclip-backfill-attachments: unexpected ${err.message}`);
  process.exit(99);
});
