#!/usr/bin/env node
/**
 * Deterministically reconcile a consolidated xAI URL inventory with the X10
 * Paperclip asset-custody manifest. This never downloads provider URLs,
 * generates media, or mutates assets: it proves only that an existing
 * Paperclip attachment has a matching immutable X10 custody record.
 */
import fs from "node:fs";
import path from "node:path";

function usage() {
  throw new Error(
    "Usage: reconcile-xai-asset-custody.mjs --inventory <inventory.json> --x10-manifest <assets.tsv> --output <report.json>",
  );
}

function readArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) usage();
    values.set(key, value);
  }
  const inventory = values.get("--inventory");
  const x10Manifest = values.get("--x10-manifest");
  const output = values.get("--output");
  if (!inventory || !x10Manifest || !output || values.size !== 3) usage();
  return { inventory, x10Manifest, output };
}

export function parseX10Manifest(text) {
  const bySha = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [custodyPath, byteSize, sha256, contentType, originalFilename, createdAt] = line.split("\t");
    if (!custodyPath || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) continue;
    const entry = { custodyPath, byteSize: Number(byteSize), sha256, contentType, originalFilename, createdAt };
    const existing = bySha.get(sha256) ?? [];
    existing.push(entry);
    bySha.set(sha256, existing);
  }
  return bySha;
}

function sameIssueCustodyPath(entry, candidate) {
  const expectedSegment = `${candidate.companyId}/issues/${candidate.issueId}/`;
  return entry.custodyPath.includes(expectedSegment);
}

export function reconcileInventory(inventory, manifestBySha, manifestPath) {
  const issues = (inventory.issues ?? []).map((issue) => {
    const candidates = (issue.attachmentCandidates ?? []).map((attachment) => {
      const candidate = { ...attachment, companyId: issue.companyId, issueId: issue.issueId };
      const matches = manifestBySha.get(attachment.sha256) ?? [];
      const sameIssueMatches = matches.filter((entry) => sameIssueCustodyPath(entry, candidate));
      return {
        attachmentId: attachment.attachmentId,
        assetId: attachment.assetId,
        originalFilename: attachment.originalFilename,
        sha256: attachment.sha256,
        byteSize: attachment.byteSize,
        contentType: attachment.contentType,
        x10Status: sameIssueMatches.length > 0
          ? "confirmed_same_issue_mirror"
          : matches.length > 0
            ? "hash_present_elsewhere"
            : "not_in_manifest",
        custodyPaths: sameIssueMatches.map((entry) => entry.custodyPath),
      };
    });
    const confirmed = candidates.filter((candidate) => candidate.x10Status === "confirmed_same_issue_mirror");
    return {
      companyId: issue.companyId,
      issueId: issue.issueId,
      identifier: issue.identifier,
      title: issue.title,
      sourceReferences: {
        commentRefs: issue.commentRefs,
        documentRefs: issue.documentRefs,
      },
      attachmentCandidates: candidates,
      reconciliationStatus: candidates.length === 0
        ? "no_paperclip_candidate"
        : confirmed.length === candidates.length
          ? "all_candidates_confirmed_on_x10"
          : confirmed.length > 0
            ? "some_candidates_confirmed_on_x10"
            : "candidates_not_confirmed_on_x10",
    };
  });
  const count = (status) => issues.filter((issue) => issue.reconciliationStatus === status).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "data_only",
    inventoryGeneratedAt: inventory.generatedAt ?? null,
    x10Manifest: manifestPath,
    importantLimit: "A confirmed X10 mirror proves custody of a Paperclip attachment, not that it is identical to a historic xAI URL reference. No provider URL was fetched, revoked, or regenerated.",
    summary: {
      issuesReviewed: issues.length,
      issuesWithNoPaperclipCandidate: count("no_paperclip_candidate"),
      issuesWithAllCandidatesConfirmedOnX10: count("all_candidates_confirmed_on_x10"),
      issuesWithSomeCandidatesConfirmedOnX10: count("some_candidates_confirmed_on_x10"),
      issuesWithCandidatesNotConfirmedOnX10: count("candidates_not_confirmed_on_x10"),
    },
    issues,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { inventory, x10Manifest, output } = readArgs(process.argv.slice(2));
  const report = reconcileInventory(
    JSON.parse(fs.readFileSync(inventory, "utf8")),
    parseX10Manifest(fs.readFileSync(x10Manifest, "utf8")),
    x10Manifest,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
}
