#!/usr/bin/env node
// reconcile-beta.mjs — done⇒on-beta reconciliation guard (NEO-528, subtask 522c of NEO-522).
//
// The check that would have caught Brand Kit (NEO-138): an issue marked `done` whose work never
// actually reached the running beta instance. NEO-521 has been doing this reconciliation BY HAND;
// this automates it so drift can't recur silently.
//
// What it does, each scheduled run:
//   1. Enumerates every issue in status `done` (Paperclip control-plane API).
//   2. For each, looks for a probe file release-probes/<IDENTIFIER>.yaml (the registry 522b built).
//        · has a probe file → runs it against the RUNNING beta via scripts/verify-content.mjs
//          (the exact same content-verify runner the deploy gate uses — NOT a second engine):
//            all probes green → LIVE
//            any probe red    → DRIFT  (closed-but-not-live — the Brand-Kit failure mode)
//        · no probe file      → UNVERIFIABLE  (surfaced, never silently passed as a false green)
//   3. Flags each DRIFT issue with a comment on that issue (idempotent — see DRIFT_MARKER).
//   4. Rolls a CTO digest: one summary comment on the digest target issue (the routine's run
//      issue), @-mentioning the CTO when there is drift to act on.
//
// WHY content, never SHA ancestry: on cortex-beta branches re-land the same work under fresh SHAs
// (renumbered migrations, ported commits), so commit lineage proves nothing about what is running.
// This asserts behaviour against the live instance — same rationale as verify-content.mjs (522b).
//
// Exit codes: 0 = no drift (green + unverifiable only); 1 = at least one DRIFT issue; 2 = usage /
// config error (missing API creds, no probe dir, etc.). Unverifiable is informational — it does
// NOT fail the run, but it is always counted and sampled in the digest.
//
// Usage:
//   PAPERCLIP_CONFIG=/home/ubuntu/.paperclip/instances/beta/config.json \
//     node scripts/reconcile-beta.mjs --base http://127.0.0.1:3200 --digest-issue <issueId>
//
// Options:
//   --base <url>             base URL of the running beta instance (default http://127.0.0.1:3200)
//   --dir <dir>              probe registry directory (default: release-probes)
//   --digest-issue <id>      issue to post the CTO digest comment on (e.g. the routine run issue)
//   --cto-agent <agentId>    agent to @-mention in the digest when there is drift (default: env
//                            RECONCILE_CTO_AGENT_ID)
//   --config <path>          PAPERCLIP_CONFIG passed through to db-type probes (default: env
//                            PAPERCLIP_CONFIG) so they assert the live DB
//   --limit-unverifiable <n> cap the unverifiable issues enumerated in the digest body (default 30;
//                            the full list is always in the --json output)
//   --comment-unverifiable   also post a per-issue comment on unverifiable issues (default: off —
//                            unverifiable is digest-only, to avoid spamming the whole backlog)
//   --timeout <ms>           per-probe-set verify timeout (default 60000)
//   --dry-run                compute + print the digest, but post NOTHING to Paperclip
//   --json                   emit a machine-readable JSON summary to stdout
//   -h | --help              this help
//
// API access (env, injected by the Paperclip heartbeat): PAPERCLIP_API_URL, PAPERCLIP_API_KEY,
// PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_RUNNER = path.join(HERE, "verify-content.mjs");

const EXIT_OK = 0; // no drift
const EXIT_DRIFT = 1; // ≥1 closed-but-not-live issue
const EXIT_CONFIG = 2; // usage / config error

const DEFAULT_DIR = "release-probes";
const DEFAULT_BASE = "http://127.0.0.1:3200";
// Stable marker embedded in every drift-flag comment (HTML comment, invisible in rendered md) so a
// re-run does not re-post the same flag on an already-flagged issue. Cleared implicitly when the
// issue goes green (no flag is posted) — human/agent resolution is not re-nagged.
const DRIFT_MARKER = "reconcile-beta:drift";

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------------
// State classes
// ---------------------------------------------------------------------------------------------
const LIVE = "live";
const DRIFT = "drift";
const UNVERIFIABLE = "unverifiable";

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    dir: DEFAULT_DIR,
    digestIssue: "",
    ctoAgent: process.env.RECONCILE_CTO_AGENT_ID ?? "",
    config: process.env.PAPERCLIP_CONFIG ?? "",
    limitUnverifiable: 30,
    commentUnverifiable: false,
    timeout: 60000,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--base": opts.base = argv[++i] ?? ""; break;
      case "--dir": opts.dir = argv[++i] ?? ""; break;
      case "--digest-issue": opts.digestIssue = argv[++i] ?? ""; break;
      case "--cto-agent": opts.ctoAgent = argv[++i] ?? ""; break;
      case "--config": opts.config = argv[++i] ?? ""; break;
      case "--limit-unverifiable": opts.limitUnverifiable = Number(argv[++i] ?? "30"); break;
      case "--comment-unverifiable": opts.commentUnverifiable = true; break;
      case "--timeout": opts.timeout = Number(argv[++i] ?? "60000"); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new ConfigError(`unknown option: ${a}`);
    }
  }
  return opts;
}

function helpText() {
  return [
    "reconcile-beta.mjs — done⇒on-beta reconciliation guard (NEO-528 / 522c)",
    "",
    "Usage:",
    "  node scripts/reconcile-beta.mjs --base <url> --digest-issue <issueId>",
    "",
    "Options:",
    "  --base <url>             running beta base URL (default http://127.0.0.1:3200)",
    "  --dir <dir>              probe registry (default release-probes)",
    "  --digest-issue <id>      issue to post the CTO digest comment on",
    "  --cto-agent <agentId>    agent @-mentioned in the digest on drift (env RECONCILE_CTO_AGENT_ID)",
    "  --config <path>          PAPERCLIP_CONFIG for db probes (env PAPERCLIP_CONFIG)",
    "  --limit-unverifiable <n> cap unverifiable issues listed in the digest (default 30)",
    "  --comment-unverifiable   also comment on each unverifiable issue (default: digest-only)",
    "  --timeout <ms>           per-probe-set verify timeout (default 60000)",
    "  --dry-run                compute + print, post nothing",
    "  --json                   emit a JSON summary",
    "",
    "Exit: 0 no drift · 1 drift found · 2 usage/config error",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Paperclip control-plane API
// ---------------------------------------------------------------------------------------------
function apiEnv() {
  const url = process.env.PAPERCLIP_API_URL ?? "";
  const key = process.env.PAPERCLIP_API_KEY ?? "";
  const company = process.env.PAPERCLIP_COMPANY_ID ?? "";
  const runId = process.env.PAPERCLIP_RUN_ID ?? "";
  if (!url || !key || !company) {
    throw new ConfigError(
      "missing Paperclip API env (need PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID)",
    );
  }
  return { url: url.replace(/\/$/, ""), key, company, runId };
}

async function api(env, method, apiPath, body) {
  const headers = {
    Authorization: `Bearer ${env.key}`,
    "X-Paperclip-Run-Id": env.runId || "reconcile-beta",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(env.url + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listDoneIssues(env) {
  const data = await api(env, "GET", `/api/companies/${env.company}/issues?status=done`);
  const items = Array.isArray(data) ? data : (data.issues ?? data.items ?? []);
  return items.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title ?? "" }));
}

async function issueHasDriftFlag(env, issueId) {
  // Idempotency: skip re-flagging an issue whose thread already carries our drift marker.
  const data = await api(env, "GET", `/api/issues/${issueId}/comments`);
  const items = Array.isArray(data) ? data : (data.comments ?? data.items ?? []);
  return items.some((c) => typeof c.body === "string" && c.body.includes(DRIFT_MARKER));
}

async function postComment(env, issueId, body) {
  // Idempotency / provenance markers live in the comment body (HTML comments), not metadata — the
  // comments API enforces a strict metadata schema, and issueHasDriftFlag() scans the body anyway.
  return api(env, "POST", `/api/issues/${issueId}/comments`, { body });
}

// ---------------------------------------------------------------------------------------------
// Probe registry ↔ issue mapping
// ---------------------------------------------------------------------------------------------
async function probeFilesByIssue(dir) {
  // identifier (uppercased stem, e.g. NEO-521) → probe file path.
  const byIssue = new Map();
  if (!existsSync(dir)) throw new ConfigError(`probe dir '${dir}' does not exist`);
  const entries = await readdir(dir);
  for (const e of entries) {
    if (!/\.(ya?ml|json)$/i.test(e)) continue;
    const stem = e.replace(/\.(ya?ml|json)$/i, "").toUpperCase();
    if (!byIssue.has(stem)) byIssue.set(stem, path.join(dir, e));
  }
  return byIssue;
}

// ---------------------------------------------------------------------------------------------
// Reuse 522b's runner — run verify-content.mjs as a subprocess and read its --json summary. This
// is the exact gate the deploy uses; we deliberately do not re-implement probe execution here.
// ---------------------------------------------------------------------------------------------
function runVerify(file, opts) {
  return new Promise((resolve) => {
    const args = [VERIFY_RUNNER, "--base", opts.base, "--timeout", String(opts.timeout), "--json", file];
    const childEnv = { ...process.env };
    if (opts.config) childEnv.PAPERCLIP_CONFIG = opts.config;
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      let summary = null;
      try { summary = JSON.parse(out); } catch { /* exit 2 (config) writes no JSON */ }
      resolve({ code, summary, err: err.trim() });
    });
    child.on("error", (e) => resolve({ code: -1, summary: null, err: e.message }));
  });
}

// ---------------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------------
async function reconcile(opts, env) {
  const byIssue = await probeFilesByIssue(opts.dir);
  const done = await listDoneIssues(env);

  const results = [];
  for (const issue of done) {
    const file = byIssue.get((issue.identifier ?? "").toUpperCase());
    if (!file) {
      results.push({ ...issue, state: UNVERIFIABLE, detail: "no probe file in release-probes/", failing: [] });
      continue;
    }
    const { code, summary, err } = await runVerify(file, opts);
    if (code === 0 && summary) {
      results.push({ ...issue, state: LIVE, file, detail: `${summary.total} probe(s) green`, failing: [] });
    } else {
      // code 1 (red probes) or 2 (unreadable/invalid probe file) or -1 (spawn error) → drift/attention.
      const failing = summary
        ? summary.results.filter((r) => !r.ok).map((r) => ({ name: r.name, type: r.type, detail: r.detail }))
        : [{ name: "(probe set)", type: "config", detail: err || `verify exited ${code}` }];
      results.push({ ...issue, state: DRIFT, file, detail: `verify exit ${code}`, failing });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Digest + flags
// ---------------------------------------------------------------------------------------------
function driftFlagBody(issue) {
  const lines = [
    `## 🔴 Drift guard: \`${issue.identifier}\` is \`done\` but NOT live on beta`,
    "",
    "Automated `done ⇒ on-beta` reconciliation (NEO-528 / 522c) ran this issue's content probes",
    `against the running beta and they did **not** pass — the work is closed but not actually`,
    "deployed. This is the exact failure mode that hid the Brand Kit gap (NEO-138).",
    "",
    `**Probe file:** \`${issue.file}\``,
    "",
    "**Failing probes:**",
    ...issue.failing.map((f) => `- \`${f.name}\` (${f.type}) — ${f.detail}`),
    "",
    "**To resolve:** redeploy so the work lands on beta (the deploy gate re-runs these probes), or",
    "correct the probe file if it is wrong. Once the probes go green this flag stops re-posting.",
    "",
    `<!-- ${DRIFT_MARKER} issue=${issue.identifier} -->`,
  ];
  return lines.join("\n");
}

function buildDigest(results, opts) {
  const live = results.filter((r) => r.state === LIVE);
  const drift = results.filter((r) => r.state === DRIFT);
  const unver = results.filter((r) => r.state === UNVERIFIABLE);
  const mention = drift.length > 0 && opts.ctoAgent ? `[@CTO](agent://${opts.ctoAgent}) ` : "";

  const lines = [
    `## ${mention}Beta reconciliation digest — \`done ⇒ on-beta\` guard (522c)`,
    "",
    `Ran the content-verify registry against \`${opts.base}\` over **${results.length}** \`done\` issue(s).`,
    "",
    `- 🟢 **Live:** ${live.length}`,
    `- 🔴 **Drift (closed but NOT live):** ${drift.length}`,
    `- ⚠️ **Unverifiable (done, no probe file):** ${unver.length}`,
    "",
  ];

  if (drift.length > 0) {
    lines.push("### 🔴 Drift — needs action", "");
    for (const d of drift) {
      lines.push(`- **${d.identifier}** — ${d.title}`);
      for (const f of d.failing) lines.push(`  - \`${f.name}\` (${f.type}): ${f.detail}`);
    }
    lines.push("");
  } else {
    lines.push("_No drift: every \`done\` issue carrying a probe file is live on beta._", "");
  }

  if (live.length > 0) {
    lines.push(`### 🟢 Live (${live.length})`, live.map((l) => l.identifier).join(", "), "");
  }

  if (unver.length > 0) {
    const shown = unver.slice(0, opts.limitUnverifiable);
    const extra = unver.length - shown.length;
    lines.push(
      `### ⚠️ Unverifiable — no probe coverage (${unver.length})`,
      "These `done` issues have no `release-probes/<ISSUE>.yaml`, so their content cannot be",
      "confirmed live. Not a false green — surfaced here so probe coverage can be added.",
      "",
      shown.map((u) => u.identifier).join(", ") + (extra > 0 ? `, …and ${extra} more (see JSON output)` : ""),
      "",
    );
  }

  lines.push(`<!-- reconcile-beta:digest drift=${drift.length} unverifiable=${unver.length} live=${live.length} -->`);
  return { markdown: lines.join("\n"), counts: { live: live.length, drift: drift.length, unverifiable: unver.length } };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`reconcile-beta: ${err.message}\n`);
    return EXIT_CONFIG;
  }
  if (opts.help) {
    process.stdout.write(helpText() + "\n");
    return EXIT_OK;
  }

  let env;
  try {
    env = apiEnv();
  } catch (err) {
    process.stderr.write(`reconcile-beta: ${err.message}\n`);
    return EXIT_CONFIG;
  }

  let results;
  try {
    results = await reconcile(opts, env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`reconcile-beta: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    process.stderr.write(`reconcile-beta: ${err.stack || err}\n`);
    return EXIT_CONFIG;
  }

  const drift = results.filter((r) => r.state === DRIFT);
  const unver = results.filter((r) => r.state === UNVERIFIABLE);
  const { markdown, counts } = buildDigest(results, opts);

  // --- side effects: flag drift issues + post the digest ---------------------------------------
  const posted = { flags: [], flagsSkipped: [], digest: null };
  if (!opts.dryRun) {
    for (const d of drift) {
      try {
        if (await issueHasDriftFlag(env, d.id)) { posted.flagsSkipped.push(d.identifier); continue; }
        await postComment(env, d.id, driftFlagBody(d));
        posted.flags.push(d.identifier);
      } catch (err) {
        process.stderr.write(`reconcile-beta: failed to flag ${d.identifier}: ${err.message}\n`);
      }
    }
    if (opts.commentUnverifiable) {
      for (const u of unver) {
        try {
          await postComment(
            env, u.id,
            `## ⚠️ Unverifiable on beta\n\n\`${u.identifier}\` is \`done\` but has no \`release-probes/${u.identifier}.yaml\`, so its content cannot be confirmed live (NEO-528 / 522c). Add a probe set so this issue joins the content-level regression suite.\n\n<!-- reconcile-beta:unverifiable issue=${u.identifier} -->`,
          );
        } catch (err) {
          process.stderr.write(`reconcile-beta: failed to note unverifiable ${u.identifier}: ${err.message}\n`);
        }
      }
    }
    if (opts.digestIssue) {
      try {
        const c = await postComment(env, opts.digestIssue, markdown);
        posted.digest = c?.id ?? true;
      } catch (err) {
        process.stderr.write(`reconcile-beta: failed to post digest: ${err.message}\n`);
      }
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ base: opts.base, counts, dryRun: opts.dryRun, posted, results }, null, 2) + "\n");
  } else {
    process.stdout.write(markdown + "\n\n");
    process.stdout.write(
      `reconcile-beta: ${counts.live} live · ${counts.drift} drift · ${counts.unverifiable} unverifiable` +
        (opts.dryRun ? " (dry-run, posted nothing)\n"
          : ` · flagged ${posted.flags.length}${posted.flagsSkipped.length ? ` (skipped ${posted.flagsSkipped.length} already-flagged)` : ""}` +
            `${posted.digest ? " · digest posted" : ""}\n`),
    );
  }
  return drift.length > 0 ? EXIT_DRIFT : EXIT_OK;
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`reconcile-beta: unexpected error: ${err?.stack || err}\n`);
      process.exit(EXIT_CONFIG);
    });
}

export { parseArgs, buildDigest, driftFlagBody, probeFilesByIssue, DRIFT_MARKER, LIVE, DRIFT, UNVERIFIABLE };
