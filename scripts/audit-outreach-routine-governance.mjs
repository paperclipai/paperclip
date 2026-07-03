#!/usr/bin/env -S node cli/node_modules/tsx/dist/cli.mjs

import {
  RR_COMPANY_ID,
  resolveRrOutreachRoutineGovernance,
  isOutreachGovernanceExemptTitle,
} from "../server/src/services/outreach-routine-governance.ts";

function parseArgs(argv) {
  const args = { identifiers: [], dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--identifiers") {
      args.identifiers = (argv[++i] || "").split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--apply") {
      args.dryRun = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.identifiers.length === 0) {
    args.identifiers = ["RR-4282", "RR-4265", "RR-4258"];
  }
  return args;
}

function isOutreachIssue(issue) {
  if (issue.companyId && issue.companyId !== RR_COMPANY_ID) return false;
  if (issue.originKind !== "routine_execution") return false;
  if (isOutreachGovernanceExemptTitle(issue.title || "")) return false;
  return Boolean(resolveRrOutreachRoutineGovernance({
    companyId: issue.companyId || RR_COMPANY_ID,
    title: issue.title || "",
    description: issue.description || null,
    assigneeAgentId: issue.assigneeAgentId || null,
  }));
}

function policyReviewer(policy) {
  return policy?.stages?.[0]?.participants?.[0]?.agentId ?? null;
}

export function diff(issue) {
  if (!isOutreachIssue(issue)) return null;
  const expected = resolveRrOutreachRoutineGovernance({
    companyId: issue.companyId || RR_COMPANY_ID,
    title: issue.title || "",
    description: issue.description || null,
    assigneeAgentId: issue.assigneeAgentId || null,
  });
  if (!expected) return null;
  const patch = {};
  const reasons = [];
  const actualReviewer = policyReviewer(issue.executionPolicy);
  const expectedReviewer = policyReviewer(expected.executionPolicy);
  if (!issue.executionPolicy || actualReviewer !== expectedReviewer) {
    patch.executionPolicy = expected.executionPolicy;
    reasons.push(issue.executionPolicy ? `executionPolicy reviewer ${actualReviewer || "missing"} != ${expectedReviewer}` : "executionPolicy missing");
  }
  if (issue.projectId !== expected.projectId) {
    patch.projectId = expected.projectId;
    reasons.push(`projectId ${issue.projectId || "missing"} != ${expected.projectId}`);
  }
  const actualLabels = new Set(issue.labelIds || []);
  const missingLabels = expected.labelIds.filter((labelId) => !actualLabels.has(labelId));
  if (missingLabels.length > 0) {
    patch.labelIds = [...new Set([...(issue.labelIds || []), ...expected.labelIds])];
    reasons.push(`labelIds missing ${missingLabels.join(",")}`);
  }
  return reasons.length > 0 ? { identifier: issue.identifier, id: issue.id, title: issue.title, reasons, patch, reviewer: policyReviewer(patch.executionPolicy ?? issue.executionPolicy) } : null;
}

export async function api(path, options = {}) {
  const baseUrl = process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_BASE_URL;
  const token = process.env.PAPERCLIP_API_KEY;
  if (!baseUrl || !token) {
    throw new Error("PAPERCLIP_API_URL/PAPERCLIP_BASE_URL and PAPERCLIP_API_KEY are required");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function getIssueByIdentifier(identifier) {
  const results = await api(`/api/companies/${RR_COMPANY_ID}/issues?q=${encodeURIComponent(identifier)}&limit=20`);
  const match = results.find((issue) => issue.identifier === identifier);
  if (!match) throw new Error(`Issue ${identifier} not found`);
  return api(`/api/issues/${match.id}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const issues = await Promise.all(args.identifiers.map(getIssueByIdentifier));
  const findings = issues.map(diff).filter(Boolean);

  console.log(`Outreach routine governance audit (${args.dryRun ? "dry-run" : "apply"})`);
  for (const finding of findings) {
    console.log(`- ${finding.identifier}: ${finding.reasons.join("; ")}`);
    console.log(`  expected reviewer: ${finding.reviewer || "unchanged"}`);
    console.log(`  patch: ${JSON.stringify(finding.patch)}`);
  }
  if (findings.length === 0) {
    console.log("No governance gaps found.");
  }

  if (!args.dryRun) {
    for (const finding of findings) {
      await api(`/api/issues/${finding.id}`, {
        method: "PATCH",
        body: JSON.stringify(finding.patch),
      });
      console.log(`patched ${finding.identifier}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
