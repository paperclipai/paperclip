// Topological sort of delete order based on FK dependencies
import { readFileSync } from "node:fs";
import { globSync } from "glob";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(__dirname, "../../packages/db/src/schema");

// All tables explicitly deleted in remove() (TS export names)
const deleteList = [
  "heartbeatRunEvents", "agentTaskSessions", "activityLog",
  "financeEvents", "costEvents", "heartbeatRuns",
  "agentWakeupRequests", "agentApiKeys", "agentRuntimeState",
  "issueComments", "approvalComments",
  "budgetIncidents", "budgetPolicies", "approvals",
  "companySecrets", "joinRequests", "invites",
  "principalPermissionGrants", "companyMemberships",
  "companySkills", "issueReadStates",
  "workspaceOperations", "workspaceRuntimeServices",
  "inboxDismissals", "documents",
  "feedbackVotes", "issueThreadInteractions", "issueInboxArchives",
  "issues", "companyLogos", "assets",
  "goals", "projects", "agents",
];

// Also add cascaded tables (they get auto-deleted, but their children might 
// depend on them being deleted first)
const cascadeResolved = [
  "documentRevisions", "issueDocuments", "issueAttachments",
  "issueExecutionDecisions", "issueApprovals", "issueRelations",
  "issueWorkProducts", "issueReferenceMentions", "issueTreeHolds",
  "issueTreeHoldMembers", "projectWorkspaces", "projectGoals",
  "executionWorkspaces", "heartbeatRunWatchdogDecisions",
  "feedbackExports", "agentConfigRevisions", "companySecretVersions",
  "environments", "environmentLeases", "labels", "issueLabels",
  "pluginCompanySettings", "routines", "routineTriggers", "routineRuns",
];

const allTables = new Set([...deleteList, ...cascadeResolved]);

// Scan all schema files and build FK graph
const edges = []; // [child, parent, cascade]

for (const file of globSync(`${schemaDir}/*.ts`)) {
  const content = readFileSync(file, "utf8");
  const tableMatch = content.match(/export const (\w+) = pgTable\(\s*"(\w+)"/);
  if (!tableMatch) continue;
  const childTs = tableMatch[1];
  
  for (const line of content.split("\n")) {
    const fkMatch = line.match(/references\(\s*\(\)\s*=>\s+(\w+)\.id/);
    if (!fkMatch) continue;
    const parentTs = fkMatch[1];
    if (!allTables.has(parentTs) || parentTs === childTs) continue;
    const hasCascade = line.includes("onDelete") && line.includes("cascade");
    const hasSetNull = line.includes("onDelete") && line.includes("set null");
    edges.push([childTs, parentTs, hasCascade || hasSetNull]);
  }
}

// For delete ordering: child must be deleted before parent UNLESS the FK has cascade/setNull
const constraints: Array<[string, string]> = [];
for (const [child, parent, isCascadeOrSetNull] of edges) {
  if (!isCascadeOrSetNull) {
    constraints.push([child, parent]);
  }
}

// Topological sort: child before parent (for deletion, delete children first)
const allNodes = new Set(deleteList);
const inDegree = new Map<string, number>();
const adj = new Map<string, string[]>();

for (const node of deleteList) {
  inDegree.set(node, 0);
  adj.set(node, []);
}

for (const [child, parent] of constraints) {
  if (!allNodes.has(child) || !allNodes.has(parent)) continue;
  // Edge: child → parent means child must be deleted before parent
  adj.get(child)!.push(parent);
  inDegree.set(parent, (inDegree.get(parent) || 0) + 1);
}

// Kahn's algorithm
const queue: string[] = [];
for (const [node, degree] of inDegree) {
  if (degree === 0) queue.push(node);
}
queue.sort();

const order: string[] = [];
while (queue.length > 0) {
  const node = queue.shift()!;
  order.push(node);
  for (const next of adj.get(node) || []) {
    const newDegree = (inDegree.get(next) || 1) - 1;
    inDegree.set(next, newDegree);
    if (newDegree === 0) queue.push(next);
  }
}

if (order.length !== deleteList.length) {
  console.error("CYCLE DETECTED! Order length:", order.length, "expected:", deleteList.length);
  const remaining = deleteList.filter(n => !order.includes(n));
  console.error("Remaining:", remaining);
} else {
  console.log("// Correct FK-safe delete order:");
  order.forEach((name, i) => console.log(`${i+1}. ${name}`));
}
