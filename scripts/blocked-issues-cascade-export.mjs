#!/usr/bin/env node

const REQUIRED_ENV = ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"];

function usage() {
  console.error(`
Blocked Issues Cascade-Clearing Export

Generates a comprehensive Markdown report of all blocked and functionally blocked
issues in the Paperclip company. Designed for pasting into ChatGPT for cascade-clearing analysis.

Trigger phrases:
  "Generate blocked issues cascade export."
  "Prepare my blocked issues packet."
  "Give me the cascade-clearing export."
  "Export all blocked issues for ChatGPT review."

Usage:
  node scripts/blocked-issues-cascade-export.mjs [options]

Options:
  --output FILE    Write report to FILE instead of stdout
  --help, -h       Show this help text

Environment variables (required):
  PAPERCLIP_API_URL    Paperclip API base URL
  PAPERCLIP_API_KEY    API key with read access
  PAPERCLIP_COMPANY_ID  Company ID to export issues for

Examples:
  node scripts/blocked-issues-cascade-export.mjs
  node scripts/blocked-issues-cascade-export.mjs --output ~/blocked-export.md
  PAPERCLIP_API_URL=https://api.paperclip.ing PAPERCLIP_API_KEY=xxx PAPERCLIP_COMPANY_ID=yyy \\
    node scripts/blocked-issues-cascade-export.mjs
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let outputPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      usage();
      process.exit(0);
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputPath = args[++i];
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      usage();
      process.exit(1);
    }
  }
  return { outputPath };
}

async function apiGet(path) {
  const url = `${process.env.PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText} — ${url}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

function stoppedAge(stoppedSinceAt) {
  if (!stoppedSinceAt) return "unknown";
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / (86400 * 7))}w`;
  return `${Math.floor(seconds / (86400 * 30))}mo`;
}

const EXECUTIVE_TEAM = {
  "99461117-637d-48ea-b911-a6ba3ee6e4b4": "Miles (CEO)",
  "cc5affb8-0a95-42c7-b7c4-a61b7c53ca97": "Hunter (CTO)",
  "09335a77-765d-4374-8846-71faf46b9de2": "Quinn (QA)",
  "2f3cd348-494c-40e8-921d-d5f610caab3f": "Hayes (Engineering)",
  "03c331d0-61f7-47d3-8905-d65036cbac72": "Penny (Product)",
  "a1da92aa-f9be-4b19-a8bf-a1b2ef6dbd8b": "Diana (Design)",
  "95210561-8835-41f4-9a24-4eb0f28d50e0": "Christie (Comms)",
  "717b8295-e4a5-4bcc-87df-1cf301c3b969": "Chase (Dispatcher)",
  "525179ef-1b62-403f-a445-25b511cc3418": "Grace (Growth)",
  "ea767651-5a8b-4236-a118-1888a1452225": "Sydney (Success)",
};

function agentLabel(agentId) {
  if (!agentId) return "Unassigned";
  return EXECUTIVE_TEAM[agentId] ?? agentId.slice(0, 8);
}

const BLOCKER_CATEGORY_LABELS = {
  blocked_chain_stalled: "Dependency chain",
  blocked_by_unassigned_issue: "Needs attention — unassigned blocker",
  blocked_by_assigned_backlog_issue: "Needs attention — parked blocker",
  blocked_by_cancelled_issue: "Needs attention — cancelled blocker",
  pending_board_decision: "Product decision required",
  pending_user_decision: "Product decision required",
  missing_successful_run_disposition: "Stale or unclear status",
  in_review_without_action_path: "QA/review gate",
  invalid_review_participant: "Agent confusion / ownership",
  open_recovery_issue: "Recovery required",
  external_owner_action: "Jeff action required",
  blocked_by_uninvokable_assignee: "Agent confusion / ownership",
};

const BROAD_CATEGORY = {
  blocked_chain_stalled: "Dependency chain",
  blocked_by_unassigned_issue: "Needs attention",
  blocked_by_assigned_backlog_issue: "Needs attention",
  blocked_by_cancelled_issue: "Needs attention",
  pending_board_decision: "Product decision required",
  pending_user_decision: "Product decision required",
  missing_successful_run_disposition: "Stale or unclear status",
  in_review_without_action_path: "QA/review gate",
  invalid_review_participant: "Agent confusion / ownership",
  open_recovery_issue: "Recovery required",
  external_owner_action: "Jeff action required",
  blocked_by_uninvokable_assignee: "Agent confusion / ownership",
};

function broadCategory(reason) {
  return BROAD_CATEGORY[reason] ?? "Other / needs investigation";
}

function requiresJeffAction(reason) {
  return ["pending_board_decision", "pending_user_decision", "external_owner_action"].includes(reason);
}

function formatAction(attention) {
  if (!attention) return "Investigate and resolve.";
  const detail = attention.action?.detail;
  if (detail) return detail;
  const reason = attention.reason;
  const map = {
    pending_board_decision: "Board (human) needs to make a decision on this issue.",
    pending_user_decision: "User/human input required before work can proceed.",
    missing_successful_run_disposition: "The last run completed. Assignee must choose a final disposition: done, cancelled, review, blocked, or queued continuation.",
    blocked_chain_stalled: "Blocker chain is stalled. Resolve the root upstream blocker first.",
    blocked_by_unassigned_issue: "A blocking issue has no assignee. Assign an owner to the blocker.",
    blocked_by_assigned_backlog_issue: "A blocking issue is parked in backlog. Move it to an active status or close it.",
    blocked_by_cancelled_issue: "A blocking issue was cancelled. Remove or replace this dependency.",
    in_review_without_action_path: "Issue is in review but has no reviewer or action path. Assign a reviewer or close.",
    invalid_review_participant: "Review participant configuration is invalid. Fix the execution policy.",
    open_recovery_issue: "A recovery issue is open and must be resolved first.",
    external_owner_action: "An external owner needs to take action before work can continue.",
    blocked_by_uninvokable_assignee: "The assignee is paused or unavailable. Reassign to an available agent.",
  };
  return map[reason] ?? "Investigate and resolve this blocker.";
}

function formatChip(reason) {
  const map = {
    blocked_chain_stalled: "Chain",
    blocked_by_unassigned_issue: "Unassigned",
    blocked_by_assigned_backlog_issue: "Parked",
    blocked_by_cancelled_issue: "Cancelled",
    pending_board_decision: "Board",
    pending_user_decision: "User",
    missing_successful_run_disposition: "Disposition",
    in_review_without_action_path: "Review",
    invalid_review_participant: "Ownership",
    open_recovery_issue: "Recovery",
    external_owner_action: "External",
    blocked_by_uninvokable_assignee: "Paused",
  };
  return map[reason] ?? "?";
}

async function main() {
  const { outputPath } = parseArgs();

  for (const env of REQUIRED_ENV) {
    if (!process.env[env]) {
      console.error(`Missing required env var: ${env}`);
      usage();
      process.exit(1);
    }
  }

  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  // Fetch all blocked-attention issues — this gives us the full blockedInboxAttention payload
  const attentionIssues = await apiGet(`/api/companies/${COMPANY_ID}/issues?attention=blocked&limit=200`);

  // Build a map of blockedInboxAttention by issue id
  const attentionByIssueId = new Map();
  for (const iss of attentionIssues) {
    if (iss.blockedInboxAttention) {
      attentionByIssueId.set(iss.id, iss.blockedInboxAttention);
    }
  }

  // Fetch full detail for each issue to get blockedBy, blocks, relatedWork, etc.
  const issueDetails = await Promise.all(
    attentionIssues.map((iss) => apiGet(`/api/issues/${iss.id}`).catch(() => null))
  );

  // Merge: use the issue details for full data, but keep blockedInboxAttention from the list query
  const mergedIssues = attentionIssues.map((listIss, i) => {
    const detail = issueDetails[i];
    if (!detail) return listIss;
    // Keep blockedInboxAttention from the attention query
    return { ...detail, blockedInboxAttention: listIss.blockedInboxAttention || detail.blockedInboxAttention };
  });

  // Fetch agents for name resolution
  const agentResult = await apiGet(`/api/companies/${COMPANY_ID}/agents`).catch(() => []);
  const agentList = Array.isArray(agentResult) ? agentResult : (agentResult?.agents || []);
  const agentMap = new Map();
  for (const a of agentList) agentMap.set(a.id, a.name || a.slug);

  function resolveAgent(agentId) {
    if (!agentId) return "Unassigned";
    return agentMap.get(agentId) || EXECUTIVE_TEAM[agentId] || agentId.slice(0, 8);
  }

  // Sort: critical first, then by stopped time (oldest first)
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  mergedIssues.sort((a, b) => {
    const aAttn = a.blockedInboxAttention;
    const bAttn = b.blockedInboxAttention;
    const aSev = severityRank[aAttn?.severity] ?? 9;
    const bSev = severityRank[bAttn?.severity] ?? 9;
    if (aSev !== bSev) return aSev - bSev;
    const aTime = aAttn?.stoppedSinceAt ? new Date(aAttn.stoppedSinceAt).getTime() : 0;
    const bTime = bAttn?.stoppedSinceAt ? new Date(bAttn.stoppedSinceAt).getTime() : 0;
    return aTime - bTime;
  });

  // ── Assemble the Markdown report ─────────────────────────────────────

  const lines = [];

  lines.push(`# Blocked Issues Cascade-Clearing Export`);
  lines.push(``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Company ID:** \`${COMPANY_ID}\``);
  lines.push(`**Total blocked/functionally blocked issues:** ${mergedIssues.length}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // ── Individual issue details ──────────────────────────────────────────

  for (const issue of mergedIssues) {
    const attn = issue.blockedInboxAttention;
    const reason = attn?.reason || "unknown";
    const category = broadCategory(reason);
    const chip = formatChip(reason);
    const needsJeff = requiresJeffAction(reason);
    const actionDetail = formatAction(attn);
    const stopped = stoppedAge(attn?.stoppedSinceAt);
    const blockedBy = issue.blockedBy || [];
    const blocks = issue.blocks || [];
    const outboundWork = issue.relatedWork?.outbound || [];
    const inboundWork = issue.relatedWork?.inbound || [];

    lines.push(`## ${issue.identifier}: ${issue.title}`);
    lines.push(``);
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Issue ID** | ${issue.identifier} |`);
    lines.push(`| **Title** | ${issue.title} |`);
    lines.push(`| **Assignee** | ${resolveAgent(issue.assigneeAgentId)} |`);
    lines.push(`| **Status** | \`${issue.status}\` |`);
    lines.push(`| **Priority** | \`${issue.priority}\` |`);
    lines.push(`| **Blocker category** | ${category} |`);
    lines.push(`| **Blocker chip** | \`${chip}\` |`);
    lines.push(`| **Blocker reason** | \`${reason}\` |`);
    lines.push(`| **Stopped since** | ${stopped} |`);
    lines.push(`| **Last updated** | ${issue.updatedAt || "?"} |`);
    lines.push(`| **Jeff action required?** | ${needsJeff ? "**YES**" : "No"} |`);

    if (needsJeff) {
      lines.push(`| **Exact Jeff action needed** | ${actionDetail} |`);
    }

    lines.push(`| **Who owns the unblock action** | ${resolveAgent(attn?.owner?.agentId || issue.assigneeAgentId)} |`);
    lines.push(`| **What is needed to unblock** | ${actionDetail} |`);

    if (blockedBy.length > 0) {
      const deps = blockedBy.map((b) =>
        `${b.identifier || "?"} — ${b.title || "?"} (${b.status})`
      ).join("<br>");
      lines.push(`| **Blocked by** | ${deps} |`);
    }
    if (blocks.length > 0) {
      const blk = blocks.map((b) =>
        `${b.identifier || "?"} — ${b.title || "?"} (${b.status})`
      ).join("<br>");
      lines.push(`| **Blocks** | ${blk} |`);
    }

    // Separate parent/child from other related work
    const children = outboundWork.filter((w) => w.kind === "child" || w.kind === "outbound");
    const parents = inboundWork.filter((w) => w.kind === "parent" || w.kind === "inbound");
    const mentions = outboundWork.filter((w) => w.kind !== "child");

    if (parents.length > 0) {
      lines.push(`| **Parent issue** | ${parents[0].issue.identifier} — ${parents[0].issue.title} (${parents[0].issue.status}) |`);
    }
    if (children.length > 0) {
      lines.push(`| **Child issues** | ${children.map((c) => `${c.issue.identifier} — ${c.issue.title} (${c.issue.status})`).join("<br>")} |`);
    }
    if (attn?.leafIssue) {
      lines.push(`| **Leaf blocker** | ${attn.leafIssue.identifier || "?"} — ${attn.leafIssue.title || "?"} |`);
    }
    if (attn?.recoveryIssue) {
      lines.push(`| **Recovery issue** | ${attn.recoveryIssue.identifier || "?"} — ${attn.recoveryIssue.title || "?"} |`);
    }
    if (attn?.approvalId) {
      lines.push(`| **Pending approval** | \`${attn.approvalId}\` |`);
    }

    const severity = attn?.severity || "?";
    lines.push(`| **Severity** | \`${severity}\` |`);
    lines.push(`| **Recommended next action** | ${actionDetail} |`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // ── Executive Summary ─────────────────────────────────────────────────

  lines.push(`## Executive Summary`);
  lines.push(``);

  const criticalCount = mergedIssues.filter((i) => i.blockedInboxAttention?.severity === "critical").length;
  const highCount = mergedIssues.filter((i) => i.blockedInboxAttention?.severity === "high").length;
  const mediumCount = mergedIssues.filter((i) => i.blockedInboxAttention?.severity === "medium").length;
  const lowCount = mergedIssues.filter((i) => i.blockedInboxAttention?.severity === "low" || !i.blockedInboxAttention?.severity).length;

  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total blocked/functionally blocked | ${mergedIssues.length} |`);
  lines.push(`| Critical severity | ${criticalCount} |`);
  lines.push(`| High severity | ${highCount} |`);
  lines.push(`| Medium severity | ${mediumCount} |`);
  lines.push(`| Low/unknown severity | ${lowCount} |`);
  if (mergedIssues.length > 0) {
    const oldest = mergedIssues[mergedIssues.length - 1];
    const oldestStopped = stoppedAge(oldest.blockedInboxAttention?.stoppedSinceAt || oldest.updatedAt);
    lines.push(`| Longest-stopped issue | ${oldest.identifier} (${oldestStopped}) |`);
    lines.push(`| Most critical issue | ${mergedIssues[0].identifier} — ${mergedIssues[0].title} |`);
  }
  lines.push(``);

  // ── Blocker Categories ────────────────────────────────────────────────

  lines.push(`## Blocker Categories`);
  lines.push(``);

  const categoryBuckets = {};
  for (const issue of mergedIssues) {
    const reason = issue.blockedInboxAttention?.reason || "unknown";
    const cat = broadCategory(reason);
    if (!categoryBuckets[cat]) categoryBuckets[cat] = [];
    categoryBuckets[cat].push(issue);
  }

  const categoryOrder = [
    "Jeff action required",
    "Product decision required",
    "Dependency chain",
    "QA/review gate",
    "Agent confusion / ownership",
    "Recovery required",
    "Needs attention",
    "Stale or unclear status",
    "Other / needs investigation",
  ];

  for (const cat of categoryOrder) {
    const issues = categoryBuckets[cat];
    if (!issues || issues.length === 0) continue;
    lines.push(`### ${cat} (${issues.length})`);
    lines.push(``);
    for (const issue of issues) {
      const chip = formatChip(issue.blockedInboxAttention?.reason);
      lines.push(`- **${issue.identifier}** [${chip}] — ${issue.title} (${issue.priority}, ${resolveAgent(issue.assigneeAgentId)})`);
    }
    lines.push(``);
  }

  // ── Cascade-Clearing Order ────────────────────────────────────────────

  lines.push(`## Cascade-Clearing Order`);
  lines.push(``);
  lines.push(`Recommended order to clear blockers, grouped into waves.`);
  lines.push(``);

  let waveNum = 0;

  // Wave 1: Jeff actions (critical + high)
  const jeffCritical = mergedIssues.filter((i) => {
    if (!requiresJeffAction(i.blockedInboxAttention?.reason)) return false;
    const sev = i.blockedInboxAttention?.severity;
    return sev === "critical" || sev === "high";
  });
  if (jeffCritical.length > 0) {
    waveNum++;
    const allDownstream = jeffCritical.flatMap((i) => (i.blocks || []).map((b) => b.identifier).filter(Boolean));
    lines.push(`### Wave ${waveNum}: Critical & High Jeff Actions`);
    lines.push(``);
    lines.push(`**Why together:** These are the highest-priority items requiring Jeff's direct attention.`);
    lines.push(``);
    for (const issue of jeffCritical) {
      const downstream = (issue.blocks || []).map((b) => b.identifier).filter(Boolean);
      lines.push(`- **${issue.identifier}** — ${issue.title}`);
      lines.push(`  - Action: ${formatAction(issue.blockedInboxAttention)}`);
      if (downstream.length > 0) {
        lines.push(`  - Downstream issues unblocked: ${downstream.join(", ")}`);
      }
    }
    lines.push(``);
  }

  // Wave 2: Remaining Jeff actions
  const jeffRemaining = mergedIssues.filter((i) => {
    if (!requiresJeffAction(i.blockedInboxAttention?.reason)) return false;
    const sev = i.blockedInboxAttention?.severity;
    return sev !== "critical" && sev !== "high";
  });
  if (jeffRemaining.length > 0) {
    waveNum++;
    lines.push(`### Wave ${waveNum}: Remaining Jeff Actions`);
    lines.push(``);
    lines.push(`**Why together:** Batch all remaining Jeff-dependent decisions for efficiency.`);
    lines.push(``);
    for (const issue of jeffRemaining) {
      lines.push(`- **${issue.identifier}** — ${issue.title}`);
      lines.push(`  - Action: ${formatAction(issue.blockedInboxAttention)}`);
    }
    lines.push(``);
  }

  // Wave 3: Dependency chains (blocked_chain_stalled)
  const chainIssues = mergedIssues.filter((i) => i.blockedInboxAttention?.reason === "blocked_chain_stalled");
  if (chainIssues.length > 0) {
    waveNum++;
    lines.push(`### Wave ${waveNum}: Resolve Blocker Chains`);
    lines.push(``);
    lines.push(`**Why together:** These issues are blocked by upstream dependencies. Clearing the root blocker(s) will cascade-clear multiple downstream items.`);
    lines.push(``);
    for (const issue of chainIssues) {
      const downstream = (issue.blocks || []).map((b) => b.identifier).filter(Boolean);
      lines.push(`- **${issue.identifier}** — ${issue.title}`);
      lines.push(`  - Action: Inspect and resolve the root blocker chain`);
      if (downstream.length > 0) {
        lines.push(`  - Blocks these downstream issues: ${downstream.join(", ")}`);
      }
    }
    lines.push(``);
  }

  // Wave 4: QA/review gate
  const reviewIssues = mergedIssues.filter((i) => i.blockedInboxAttention?.reason === "in_review_without_action_path");
  if (reviewIssues.length > 0) {
    waveNum++;
    lines.push(`### Wave ${waveNum}: Resolve Review Gates`);
    lines.push(``);
    lines.push(`**Why together:** These need reviewer assignment or a clear action path.`);
    lines.push(``);
    for (const issue of reviewIssues) {
      lines.push(`- **${issue.identifier}** — ${issue.title}`);
      lines.push(`  - Action: ${formatAction(issue.blockedInboxAttention)}`);
    }
    lines.push(``);
  }

  // Wave 5: Stalled / needs attention / recovery
  const stalledIssues = mergedIssues.filter((i) => {
    const r = i.blockedInboxAttention?.reason;
    return r && r !== "blocked_chain_stalled" && r !== "in_review_without_action_path" && !requiresJeffAction(r);
  });
  if (stalledIssues.length > 0) {
    waveNum++;
    lines.push(`### Wave ${waveNum}: Agent-Owned Blocked Issues`);
    lines.push(``);
    lines.push(`**Why together:** These are blocked or functionally blocked issues that assigned agents can resolve independently.`);
    lines.push(``);
    for (const issue of stalledIssues) {
      lines.push(`- **${issue.identifier}** — ${issue.title} (→ ${resolveAgent(issue.assigneeAgentId)})`);
      lines.push(`  - Action: ${formatAction(issue.blockedInboxAttention)}`);
    }
    lines.push(``);
  }

  // ── Jeff Action List ──────────────────────────────────────────────────

  const jeffIssues = mergedIssues.filter((i) => requiresJeffAction(i.blockedInboxAttention?.reason));
  lines.push(`## Jeff Action List`);
  lines.push(``);
  if (jeffIssues.length === 0) {
    lines.push(`No items currently require Jeff action.`);
  } else {
    lines.push(`| Issue | Exact Action Required | Urgency | Consequence if Ignored |`);
    lines.push(`|-------|----------------------|---------|------------------------|`);
    for (const issue of jeffIssues) {
      const sev = issue.blockedInboxAttention?.severity || "medium";
      const urgency = sev === "critical" ? "**IMMEDIATE**" : sev === "high" ? "**Today**" : "This week";
      const detail = formatAction(issue.blockedInboxAttention);
      const downstream = (issue.blocks || []).map((b) => b.identifier).filter(Boolean);
      const consequence = downstream.length > 0
        ? `Blocks downstream: ${downstream.join(", ")}`
        : "Issue remains unresolved, may block future work";
      lines.push(`| **${issue.identifier}** | ${detail} | ${urgency} | ${consequence} |`);
    }
  }
  lines.push(``);

  // ── Agent Action List ─────────────────────────────────────────────────

  lines.push(`## Agent Action List`);
  lines.push(``);

  const agentBuckets = {};
  for (const issue of mergedIssues) {
    const assignee = resolveAgent(issue.assigneeAgentId);
    if (!agentBuckets[assignee]) agentBuckets[assignee] = [];
    agentBuckets[assignee].push(issue);
  }

  for (const [agent, issues] of Object.entries(agentBuckets).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${agent}`);
    lines.push(``);
    for (const issue of issues) {
      const action = formatAction(issue.blockedInboxAttention);
      lines.push(`- **${issue.identifier}** — ${issue.title}`);
      lines.push(`  - Next action: ${action}`);
    }
    lines.push(``);
  }

  // ── Risks / Warnings ──────────────────────────────────────────────────

  lines.push(`## Risks / Warnings`);
  lines.push(``);

  const warnings = [];

  // Warn about chain-blocked issues
  const chainBlocked = mergedIssues.filter((i) => i.blockedInboxAttention?.reason === "blocked_chain_stalled");
  if (chainBlocked.length > 0) {
    warnings.push(
      `- **${chainBlocked.length} chain-blocked issues** identified. Resolving the root blocker(s) will cascade-clear multiple downstream items. Prioritize root causes over individual issue reassignment.`
    );
  }

  // Warn about stale dispositions
  const staleDispo = mergedIssues.filter((i) => i.blockedInboxAttention?.reason === "missing_successful_run_disposition");
  if (staleDispo.length > 0) {
    warnings.push(
      `- **${staleDispo.length} issues with missing run disposition** — these completed runs but were never closed out. Assign an owner to pick a final disposition.`
    );
  }

  // Warn about cancelled blockers
  const cancelledBlockers = mergedIssues.filter((i) => i.blockedInboxAttention?.reason === "blocked_by_cancelled_issue");
  if (cancelledBlockers.length > 0) {
    warnings.push(
      `- **${cancelledBlockers.length} issues blocked by cancelled dependencies** — these blocked-by references should be removed or replaced.`
    );
  }

  if (warnings.length === 0) {
    warnings.push("- No significant risks or warnings identified.");
  }

  lines.push(warnings.join("\n"));
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`_Report generated by \`scripts/blocked-issues-cascade-export.mjs\`_`);
  lines.push(``);

  const report = lines.join("\n");

  if (outputPath) {
    const fs = await import("node:fs");
    fs.writeFileSync(outputPath, report, "utf-8");
    console.log(`Report written to ${outputPath}`);
  } else {
    console.log(report);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
