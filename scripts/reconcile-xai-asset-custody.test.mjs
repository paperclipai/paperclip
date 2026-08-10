import assert from "node:assert/strict";
import test from "node:test";
import { parseX10Manifest, reconcileInventory } from "./reconcile-xai-asset-custody.mjs";

test("confirms only a same-issue immutable X10 mirror", () => {
  const sha = "a".repeat(64);
  const inventory = {
    generatedAt: "2026-08-10T00:00:00Z",
    issues: [{
      companyId: "company-1",
      issueId: "issue-1",
      identifier: "TEST-1",
      title: "test",
      commentRefs: 1,
      documentRefs: 0,
      attachmentCandidates: [{ attachmentId: "attachment-1", assetId: "asset-1", originalFilename: "clip.mp4", sha256: sha, byteSize: 8, contentType: "video/mp4" }],
    }],
  };
  const manifest = parseX10Manifest([
    `company-1/issues/issue-1/2026/08/10/asset-1-clip.mp4\t8\t${sha}\tvideo/mp4\tclip.mp4\t2026-08-10`,
    `company-2/issues/issue-2/2026/08/10/asset-2-copy.mp4\t8\t${sha}\tvideo/mp4\tcopy.mp4\t2026-08-10`,
  ].join("\n"));

  const report = reconcileInventory(inventory, manifest, "/Volumes/X10 Pro/manifest.tsv");
  assert.equal(report.summary.issuesWithAllCandidatesConfirmedOnX10, 1);
  assert.equal(report.issues[0].attachmentCandidates[0].x10Status, "confirmed_same_issue_mirror");
});

test("does not claim custody for a matching hash in another issue", () => {
  const sha = "b".repeat(64);
  const inventory = { issues: [{ companyId: "company-1", issueId: "issue-1", identifier: "TEST-1", title: "test", attachmentCandidates: [{ attachmentId: "attachment-1", assetId: "asset-1", originalFilename: "clip.mp4", sha256: sha, byteSize: 8, contentType: "video/mp4" }] }] };
  const manifest = parseX10Manifest(`company-2/issues/issue-2/2026/08/10/asset-2-copy.mp4\t8\t${sha}\tvideo/mp4\tcopy.mp4\t2026-08-10`);

  const report = reconcileInventory(inventory, manifest, "/Volumes/X10 Pro/manifest.tsv");
  assert.equal(report.summary.issuesWithCandidatesNotConfirmedOnX10, 1);
  assert.equal(report.issues[0].attachmentCandidates[0].x10Status, "hash_present_elsewhere");
});
