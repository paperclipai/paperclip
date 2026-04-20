#!/usr/bin/env npx tsx
/**
 * Retroactively runs the post-done cleanup for execution workspaces whose
 * source issue is already in `done` status but whose workspace row was never
 * cleaned up (i.e. status is not 'closed').
 *
 * Runs in DRY-RUN mode by default. Pass --apply to perform real deletions.
 *
 * Usage:
 *   npx tsx scripts/cleanup-legacy-branches.ts
 *   npx tsx scripts/cleanup-legacy-branches.ts --apply
 *   PAPERCLIP_POSTDONE_CLEANUP_ALLOWED_ROOTS=/home/user/projects/ npx tsx scripts/cleanup-legacy-branches.ts --apply
 */

import path from "node:path";
import { createDb, executionWorkspaces, issues } from "@paperclipai/db";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { runPostDoneCleanup } from "../server/src/services/post-done-cleanup.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required.");
  process.exit(1);
}

const isApply = process.argv.includes("--apply");
const allowedRoots = process.env.PAPERCLIP_POSTDONE_CLEANUP_ALLOWED_ROOTS
  ? process.env.PAPERCLIP_POSTDONE_CLEANUP_ALLOWED_ROOTS.split(",").map((r) => r.trim()).filter(Boolean)
  : ["~/Documents/Projects/"];

console.log(`Mode: ${isApply ? "APPLY" : "DRY-RUN (pass --apply to commit changes)"}`);
console.log(`Allowed roots: ${allowedRoots.join(", ")}`);

const db = createDb(DATABASE_URL);

// Find local_fs workspaces that are not yet closed and have a done source issue.
const candidates = await db
  .select({
    workspaceId: executionWorkspaces.id,
    issueId: executionWorkspaces.sourceIssueId,
    branchName: executionWorkspaces.branchName,
    cwd: executionWorkspaces.cwd,
    providerType: executionWorkspaces.providerType,
    workspaceStatus: executionWorkspaces.status,
  })
  .from(executionWorkspaces)
  .innerJoin(issues, eq(executionWorkspaces.sourceIssueId, issues.id))
  .where(
    and(
      ne(executionWorkspaces.status, "closed"),
      eq(issues.status, "done"),
      isNotNull(executionWorkspaces.sourceIssueId),
    ),
  );

console.log(`\nFound ${candidates.length} workspace(s) eligible for cleanup.`);

if (candidates.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

for (const candidate of candidates) {
  const label = `ws:${candidate.workspaceId.slice(0, 8)} issue:${candidate.issueId?.slice(0, 8)} branch:${candidate.branchName ?? "n/a"} cwd:${candidate.cwd ?? "n/a"}`;
  console.log(`\n[${isApply ? "APPLY" : "DRY-RUN"}] ${label}`);

  if (!isApply) {
    console.log(`  → Would run cleanup (providerType=${candidate.providerType})`);
    continue;
  }

  try {
    await runPostDoneCleanup({
      db,
      issueId: candidate.issueId!,
      issueIdentifier: candidate.issueId!,
      allowedRoots,
    });
    console.log("  → Done");
  } catch (err) {
    console.error(`  → ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nFinished. ${isApply ? "Applied" : "Dry-run complete — no changes made"}.`);
process.exit(0);
