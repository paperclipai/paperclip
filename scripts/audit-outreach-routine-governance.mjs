#!/usr/bin/env node

const RR_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "0fabe377-3008-4cde-96ad-b1ae5eb5e469";
const RR_OPERATIONS_PROJECT_ID = "8e99b255-02f1-401d-ab06-93cc8dc15552";
const RR_OUTREACH_GO_LIVE_PROJECT_ID = "202c77b2-e2d0-4030-a416-e41fcf246a3e";
const RR_AUTOMATE_LABEL_ID = "519fc58e-0411-4b5d-bdeb-02fb637e4f8f";
const RR_OUTREACH_LABEL_ID = "7f4ac6f1-6e9e-472d-a751-899b6a0c16d1";
const RR_CONTENT_LABEL_ID = "6c443851-fe4f-44e9-b11f-a4e2b9a4cbcd";
const RR_CEO_AGENT_ID = "ce56f1d2-941d-42b1-a54b-fc99897d6e9e";
const RR_OUTREACH_MANAGER_AGENT_ID = "c100bafe-c428-4e55-be99-0ec4ebaa32a0";

const OUTREACH_DIRECT_REPORT_AGENT_IDS = new Set([
  "e7651b93-a8ca-4c74-8ac0-2003678abb77",
  "431f481e-ee9a-4bac-a38a-8076db805f09",
  "a4a8d13b-3f28-49fb-b16e-78e5ba5a57f3",
  "6962d181-7524-4a9b-a1a2-de5e7de1f7f1",
  "e27b046d-6518-492c-99d6-d10ad8cdea63",
  "7fd12a67-5597-4eba-ae75-e4c2aea9cb7c",
]);
const EXEMPT_TITLE_PREFIXES = ["Review productivity for", "[HOT LEAD]", "[INDUSTRY INTEL]", "Content idea:"];

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

function executionPolicy(reviewerAgentId) {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewerAgentId }] }],
  };
}

function isExempt(title) {
  return EXEMPT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

function isOutreachIssue(issue) {
  if (issue.companyId && issue.companyId !== RR_COMPANY_ID) return false;
  if (issue.originKind !== "routine_execution") return false;
  if (isExempt(issue.title || "")) return false;
  if (issue.assigneeAgentId === RR_OUTREACH_MANAGER_AGENT_ID) return true;
  if (issue.assigneeAgentId && OUTREACH_DIRECT_REPORT_AGENT_IDS.has(issue.assigneeAgentId)) return true;
  return /outreach manager/i.test(issue.title || "");
}

function expectedGovernance(issue) {
  const text = `${issue.title || ""}\n${issue.description || ""}`.toLowerCase();
  const isOrgProcess = /\b(self-improvement|self improvement|automation|automate|executionpolicy scan|policy scan|governance|audit)\b/.test(text);
  const title = (issue.title || "").toLowerCase();
  const isLinkedInContent = /\blinkedin\b/.test(title) && /\b(content|publish|post)\b/.test(title);
  const reviewerAgentId = issue.assigneeAgentId === RR_OUTREACH_MANAGER_AGENT_ID || /outreach manager/i.test(issue.title || "")
    ? RR_CEO_AGENT_ID
    : RR_OUTREACH_MANAGER_AGENT_ID;
  return {
    projectId: isOrgProcess ? RR_OPERATIONS_PROJECT_ID : RR_OUTREACH_GO_LIVE_PROJECT_ID,
    labelIds: [
      ...(isOrgProcess ? [RR_AUTOMATE_LABEL_ID] : []),
      RR_OUTREACH_LABEL_ID,
      ...(isLinkedInContent ? [RR_CONTENT_LABEL_ID] : []),
    ],
    executionPolicy: executionPolicy(reviewerAgentId),
  };
}

function policyReviewer(policy) {
  return policy?.stages?.[0]?.participants?.[0]?.agentId ?? null;
}

function diff(issue) {
  if (!isOutreachIssue(issue)) return null;
  const expected = expectedGovernance(issue);
  const patch = {};
  const reasons = [];
  if (!issue.executionPolicy) {
    patch.executionPolicy = expected.executionPolicy;
    reasons.push("executionPolicy missing");
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

async function api(path, options = {}) {
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

async function getIssueByIdentifier(identifier) {
  const results = await api(`/api/companies/${RR_COMPANY_ID}/issues?q=${encodeURIComponent(identifier)}&limit=20`);
  const match = results.find((issue) => issue.identifier === identifier);
  if (!match) throw new Error(`Issue ${identifier} not found`);
  return api(`/api/issues/${match.id}`);
}

const args = parseArgs(process.argv.slice(2));
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
