#!/usr/bin/env node
// Bounded repair for PR-preparation issues stranded on a shared or stale
// execution-workspace binding (PAP-17617). For each explicit issue=branch
// pair, this pins the issue's executionWorkspaceSettings to the exact-branch
// isolated-worktree contract:
//   { mode: "isolated_workspace",
//     workspaceStrategy: { type: "git_worktree", existingBranch: "<branch>" } }
// Dispatch then attaches a git worktree on exactly that branch and ignores a
// mismatched inherited reuse_existing binding. The script only PATCHes issues
// through the company-scoped API; it never runs git and never mutates or
// deletes any branch.
//
// Usage:
//   node scripts/repair-pr-prep-workspace-attachment.mjs PAP-16555=PAP-14380-salvage-pap-9514 [more ISSUE=BRANCH ...] [--apply]
//
// Without --apply it reports the current binding and the patch it would send.
// Requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY in the environment.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pairs = args.filter((arg) => !arg.startsWith("--")).map((arg) => {
  const separator = arg.indexOf("=");
  if (separator <= 0 || separator === arg.length - 1) {
    console.error(`Expected ISSUE=BRANCH, got "${arg}"`);
    process.exit(1);
  }
  return { issue: arg.slice(0, separator), branch: arg.slice(separator + 1) };
});
if (pairs.length === 0) {
  console.error("No ISSUE=BRANCH pairs given. Nothing to repair.");
  process.exit(1);
}

const apiUrl = process.env.PAPERCLIP_API_URL;
const apiKey = process.env.PAPERCLIP_API_KEY;
if (!apiUrl || !apiKey) {
  console.error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required.");
  process.exit(1);
}
const apiBase = apiUrl.replace(/\/$/, "").replace(/\/api$/, "");
const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  ...(process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {}),
};

let failed = false;
for (const { issue, branch } of pairs) {
  const current = await fetch(`${apiBase}/api/issues/${issue}`, { headers });
  if (!current.ok) {
    console.error(`${issue}: fetch failed (${current.status})`);
    failed = true;
    continue;
  }
  const existing = await current.json();
  const settings = {
    mode: "isolated_workspace",
    workspaceStrategy: { type: "git_worktree", existingBranch: branch },
  };
  console.log(
    `${issue}: status=${existing.status} preference=${existing.executionWorkspacePreference ?? "null"} ` +
      `workspace=${existing.executionWorkspaceId ?? "null"} settings=${JSON.stringify(existing.executionWorkspaceSettings)}`,
  );
  if (!apply) {
    console.log(`${issue}: would PATCH executionWorkspaceSettings=${JSON.stringify(settings)}`);
    continue;
  }
  const response = await fetch(`${apiBase}/api/issues/${issue}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      executionWorkspaceSettings: settings,
      comment:
        `Repair for PAP-17617/PAP-17618: pinned this PR-preparation task to an isolated git worktree on the exact ` +
        `existing branch \`${branch}\` via workspaceStrategy.existingBranch. Dispatch will attach that branch ` +
        `(never create or reset it) and will not reuse the stale inherited workspace binding.`,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`${issue}: PATCH failed (${response.status}): ${body.slice(0, 500)}`);
    failed = true;
    continue;
  }
  console.log(`${issue}: PATCHED — executionWorkspaceSettings now pins existingBranch=${branch}`);
}
process.exit(failed ? 1 : 0);
