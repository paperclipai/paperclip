#!/usr/bin/env node
/**
 * RECOVERY TOOL — use when an onboarding case has wrong/missing files in SharePoint.
 *
 * Normal onboarding uses sharepoint_transfer_from_outlook via the HR agent (Phase 9).
 * This script is for manually fixing broken past cases outside the agent flow.
 *
 * Reads the Attachment Lookup Table from the employee's case-tracker.md in
 * SharePoint, deletes any stale .txt/.md files, and re-uploads the actual binaries.
 *
 * Usage:
 *   node scripts/recover-sharepoint-docs.mjs <employee-full-name> <date-of-joining>
 *
 * Example:
 *   node scripts/upload-binary-docs.mjs "Tanuku Venkata Vishnu Sai Karthik" "2026-05-01"
 *
 * Reads credentials from .paperclip/.env
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ── Load .env ────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, "../.paperclip/.env");
const envLines = readFileSync(envPath, "utf-8").split("\n");
for (const line of envLines) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

// ── Args ──────────────────────────────────────────────────────────────────────

const [, , EMPLOYEE, DOJ] = process.argv;
if (!EMPLOYEE || !DOJ) {
  console.error('Usage: node scripts/recover-sharepoint-docs.mjs "<employee-full-name>" "<YYYY-MM-DD>"');
  process.exit(1);
}

const BASE_PATH  = `HR-Onboarding/${EMPLOYEE} - ${DOJ}`;
const TRACKER    = `${BASE_PATH}/case-tracker.md`;

const GRAPH       = "https://graph.microsoft.com/v1.0";
const TENANT_ID   = process.env.SHAREPOINT_TENANT_ID;
const CLIENT_ID   = process.env.SHAREPOINT_CLIENT_ID;
const SECRET      = process.env.SHAREPOINT_CLIENT_SECRET;
const SITE_URL    = process.env.SHAREPOINT_SITE_URL;
const MAILBOX     = process.env.OUTLOOK_MAILBOX;
const OL_CLIENT   = process.env.OUTLOOK_CLIENT_ID   || CLIENT_ID;
const OL_SECRET   = process.env.OUTLOOK_CLIENT_SECRET || SECRET;

// ── Token cache ───────────────────────────────────────────────────────────────

const _tokens = {};

async function getToken(clientId, clientSecret) {
  const key = clientId;
  if (_tokens[key]) return _tokens[key];
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Token error: ${JSON.stringify(json)}`);
  _tokens[key] = json.access_token;
  return json.access_token;
}

const spToken  = () => getToken(CLIENT_ID, SECRET);
const olToken  = () => getToken(OL_CLIENT, OL_SECRET);

// ── SharePoint helpers ────────────────────────────────────────────────────────

let _siteId, _driveId;

async function getSiteId() {
  if (_siteId) return _siteId;
  const u = new URL(SITE_URL);
  const res = await fetch(`${GRAPH}/sites/${u.hostname}:/${u.pathname.replace(/^\//, "")}`, {
    headers: { Authorization: `Bearer ${await spToken()}` },
  });
  const j = await res.json();
  if (!j.id) throw new Error(`getSiteId: ${JSON.stringify(j)}`);
  return (_siteId = j.id);
}

async function getDriveId() {
  if (_driveId) return _driveId;
  const siteId = await getSiteId();
  const res = await fetch(`${GRAPH}/sites/${siteId}/drives`, {
    headers: { Authorization: `Bearer ${await spToken()}` },
  });
  const j = await res.json();
  const drive = j.value?.find(d => d.name === "Documents") ?? j.value?.[0];
  if (!drive) throw new Error("No SharePoint drive found");
  return (_driveId = drive.id);
}

async function spReadFile(filePath) {
  const siteId  = await getSiteId();
  const driveId = await getDriveId();
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `${GRAPH}/sites/${siteId}/drives/${driveId}/root:/${encoded}:/content`,
    { headers: { Authorization: `Bearer ${await spToken()}` } }
  );
  if (!res.ok) throw new Error(`spReadFile ${res.status}: ${filePath}`);
  return res.text();
}

async function spUpload(filePath, buffer, mimeType) {
  const siteId  = await getSiteId();
  const driveId = await getDriveId();
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `${GRAPH}/sites/${siteId}/drives/${driveId}/root:/${encoded}:/content`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${await spToken()}`, "Content-Type": mimeType },
      body: buffer,
    }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`spUpload ${res.status}: ${JSON.stringify(j)}`);
  return { name: j.name, size: j.size, webUrl: j.webUrl };
}

async function spDelete(filePath) {
  const siteId  = await getSiteId();
  const driveId = await getDriveId();
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `${GRAPH}/sites/${siteId}/drives/${driveId}/root:/${encoded}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${await spToken()}` } }
  );
  if (res.status === 404) return "not_found";
  if (!res.ok) throw new Error(`spDelete ${res.status}: ${filePath}`);
  return "deleted";
}

// ── Outlook helpers ───────────────────────────────────────────────────────────

async function olDownload(messageId, attachmentId) {
  // Use /$value to stream raw bytes — avoids base64 size limits
  const url = `${GRAPH}/users/${MAILBOX}/messages/${messageId}/attachments/${attachmentId}/$value`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await olToken()}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`olDownload ${res.status}: ${body.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Parse Attachment Lookup Table from case-tracker.md ───────────────────────
//
// Expects a markdown table like:
// | Filename | messageId | attachmentId | folder |
// |---|---|---|---|
// | resume.pdf | AAMk... | AAMk... | 01_Raw_Submissions |

function parseAttachmentTable(markdown) {
  const lines = markdown.split("\n");
  const headerIdx = lines.findIndex(l => /Filename.*messageId.*attachmentId/i.test(l));
  if (headerIdx === -1) throw new Error("Attachment Lookup Table not found in case-tracker.md");

  const headers = lines[headerIdx].split("|").map(s => s.trim()).filter(Boolean);
  const filenameCol   = headers.findIndex(h => /filename/i.test(h));
  const messageIdCol  = headers.findIndex(h => /messageid/i.test(h));
  const attachIdCol   = headers.findIndex(h => /attachmentid/i.test(h));
  const mimeCol       = headers.findIndex(h => /mime|contenttype/i.test(h));

  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|") || /^[|\s-]+$/.test(line)) continue;
    const cols = line.split("|").map(s => s.trim()).filter(Boolean);
    if (cols.length < 3) break;
    rows.push({
      filename:     cols[filenameCol]  ?? cols[0],
      messageId:    cols[messageIdCol] ?? cols[1],
      attachmentId: cols[attachIdCol]  ?? cols[2],
      mimeType:     mimeCol >= 0 ? cols[mimeCol] : null,
    });
  }
  if (rows.length === 0) throw new Error("Attachment Lookup Table is empty");
  return rows;
}

function guessMime(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = {
    pdf:  "application/pdf",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    png:  "image/png",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Stale file detection ──────────────────────────────────────────────────────
// Delete any .txt or .md files in the two upload folders (leftovers from text-only era)

async function deleteStaleTextFiles(folders) {
  const siteId  = await getSiteId();
  const driveId = await getDriveId();
  let deleted = 0;

  for (const folder of folders) {
    const encoded = folder.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(
      `${GRAPH}/sites/${siteId}/drives/${driveId}/root:/${encoded}:/children?$select=name,id`,
      { headers: { Authorization: `Bearer ${await spToken()}` } }
    );
    if (!res.ok) continue;
    const j = await res.json();
    for (const item of j.value ?? []) {
      if (/\.(txt|md)$/i.test(item.name)) {
        const r = await spDelete(`${folder}/${item.name}`);
        console.log(`  ${r === "deleted" ? "✓ deleted" : "⚠ " + r}: ${item.name}`);
        if (r === "deleted") deleted++;
      }
    }
  }
  return deleted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Binary Document Upload ===`);
  console.log(`Employee : ${EMPLOYEE}`);
  console.log(`DOJ      : ${DOJ}`);
  console.log(`Folder   : ${BASE_PATH}\n`);

  // 1. Read case-tracker to get attachment lookup table
  console.log("Reading case-tracker.md from SharePoint...");
  const tracker = await spReadFile(TRACKER);
  const attachments = parseAttachmentTable(tracker);
  console.log(`Found ${attachments.length} attachment(s) in lookup table.\n`);

  // 2. Delete stale .txt / .md files
  const uploadFolders = [
    `${BASE_PATH}/01_Raw_Submissions`,
    `${BASE_PATH}/02_Verified_Documents`,
  ];
  console.log("Deleting stale .txt/.md files...");
  const deletedCount = await deleteStaleTextFiles(uploadFolders);
  console.log(`Deleted ${deletedCount} stale file(s).\n`);

  // 3. Download from Outlook + upload to both SP folders
  const results = [];

  for (const att of attachments) {
    const mimeType = att.mimeType || guessMime(att.filename);
    console.log(`→ ${att.filename} (${mimeType})`);

    let buffer;
    try {
      buffer = await olDownload(att.messageId, att.attachmentId);
      console.log(`  downloaded: ${(buffer.length / 1024).toFixed(1)} KB`);
    } catch (e) {
      console.error(`  ✗ download failed: ${e.message}`);
      results.push({ file: att.filename, status: "FAIL_DOWNLOAD", error: e.message });
      continue;
    }

    let allOk = true;
    for (const folder of uploadFolders) {
      const dest = `${folder}/${att.filename}`;
      try {
        const r = await spUpload(dest, buffer, mimeType);
        console.log(`  ✓ ${folder.split("/").pop()}: ${(r.size / 1024).toFixed(1)} KB`);
      } catch (e) {
        console.error(`  ✗ upload failed (${folder.split("/").pop()}): ${e.message}`);
        allOk = false;
      }
    }

    results.push({ file: att.filename, status: allOk ? "OK" : "PARTIAL", sizekb: (buffer.length / 1024).toFixed(1) });
    console.log();
  }

  // 4. Summary
  console.log("=== Summary ===");
  let failures = 0;
  for (const r of results) {
    const icon = r.status === "OK" ? "✓" : "✗";
    const detail = r.status === "OK" ? `${r.sizekb} KB` : r.error ?? r.status;
    console.log(`${icon} ${r.file}: ${detail}`);
    if (r.status !== "OK") failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll files uploaded successfully.");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
