#!/usr/bin/env node
// request-release-approval.mjs — build + POST the weekly release-approval request_confirmation.
//
// Called by request-release-approval.sh in routine or dry-run mode.
// In dry-run mode: prints the interaction payload JSON to stdout and exits 0.
// In live mode: POSTs to the Paperclip control-plane API and exits 0 on success, 1 on error.
//
// CLI args:
//   --candidate <sha>    release candidate SHA (required)
//   --issue <id>         Paperclip issue ID to target (e.g. "NEO-600")
//   --summary <text>     version-change-log text from the train
//   --dry-run            print JSON payload only; no POST
//
// API access env (injected by Paperclip heartbeat):
//   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID

const args = process.argv.slice(2);

function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] ?? "" : "";
}

const candidate = argValue("--candidate");
const issueId = argValue("--issue");
const summary = argValue("--summary");
const dryRun = args.includes("--dry-run");

if (!candidate) {
  process.stderr.write("request-release-approval.mjs: --candidate is required\n");
  process.exit(1);
}

const idempotencyKey = `confirmation:${issueId}:release:${candidate}`;

const detailsMarkdown = [
  `## Weekly Release Candidate: \`${candidate.slice(0, 12)}\``,
  "",
  "**To approve**, write the candidate SHA to the approval token file and restart the train:",
  "```",
  `echo ${candidate} > /var/tmp/cortex-release-approval.token`,
  "systemctl start cortex-weekly-train.service",
  "```",
  "",
  "### Change Log",
  summary || "(no change log available)",
].join("\n");

const body = {
  kind: "request_confirmation",
  continuationPolicy: "wake_assignee_on_accept",
  payload: {
    version: 1,
    target: { revisionId: candidate },
    detailsMarkdown,
  },
};

if (dryRun) {
  process.stdout.write(
    JSON.stringify({ dryRun: true, idempotencyKey, body }, null, 2) + "\n"
  );
  process.exit(0);
}

// Live POST
const apiUrl = process.env.PAPERCLIP_API_URL ?? "";
const apiKey = process.env.PAPERCLIP_API_KEY ?? "";
const companyId = process.env.PAPERCLIP_COMPANY_ID ?? "";

if (!apiUrl || !apiKey) {
  process.stderr.write("request-release-approval.mjs: PAPERCLIP_API_URL / PAPERCLIP_API_KEY unset\n");
  process.exit(1);
}

const url = `${apiUrl}/api/issues/${issueId}/interactions`;

async function post() {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(companyId ? { "X-Company-ID": companyId } : {}),
    },
    body: JSON.stringify({ idempotencyKey, ...body }),
  });

  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(
      `request-release-approval.mjs: POST ${url} → ${res.status}: ${text}\n`
    );
    process.exit(1);
  }

  process.stdout.write(`raised request_confirmation for candidate ${candidate.slice(0, 12)} on ${issueId}\n`);
}

post().catch((err) => {
  process.stderr.write(`request-release-approval.mjs: ${err.message}\n`);
  process.exit(1);
});
