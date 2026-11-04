#!/usr/bin/env node
/**
 * Disconnect-handling guard: finds UI code that renders raw query
 * errors or opts out of the shared retry policy.
 *
 * During an outage the app shows one connection banner and keeps loaded data
 * on screen. These patterns break that:
 *
 *   raw-error-message   {error.message}, {query.error?.message}
 *   cast-error-message  {(error as Error).message}
 *   is-error-render     isError ? … / isError && …  (usually hides cached data)
 *   retry-false         retry: false  (skips transient retry; use the defaults
 *                       in ui/src/lib/query-client.ts)
 *
 * Use `describeError` (ui/src/api/errors.ts) for copy and render cached data
 * before errors. Intentional exceptions go in ALLOWLIST below as
 * "<path>:<rule>" with a reason.
 *
 * Report-only by default: prints findings and exits 0, except for findings in
 * ENFORCED_FILES (surfaces already migrated), which always exit 1. `--enforce`
 * exits 1 on any finding outside the allowlist (CI turns this on once the
 * long tail migrates).
 *
 * Usage: node scripts/check-query-error-rendering.mjs [--enforce] [--summary]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScanRoot = join(repoRoot, "ui/src");

export const RULES = [
  {
    id: "raw-error-message",
    description: "renders a raw error message; use describeError()",
    pattern: /\{\s*[\w$.?!]*\b(?:error|err|e|[a-z]\w*Error)\s*[?!]?\.message\s*\}/,
  },
  {
    id: "cast-error-message",
    description: "renders a cast error message; use describeError()",
    pattern: /\{\s*\(\s*[\w$.?!]+\s+as\s+(?:Error|ApiError)\s*\)\s*\??\.message\s*\}/,
  },
  {
    id: "is-error-render",
    description: "branches rendering on isError; render cached data first",
    // `isError ?` / `isError &&`, not `isError?.x`, `isError ?? x`, or `isError?: boolean`.
    pattern: /\bisError\s*(?:\?(?![.?:])|&&)/,
  },
  {
    id: "retry-false",
    description: "disables retry; rely on the query-client defaults",
    pattern: /\bretry\s*:\s*false\b/,
  },
];

/**
 * Intentional exceptions, as "<repo-relative path>:<rule id>". Each entry needs
 * a reason. The list shrinks as surfaces migrate to the shared error handling.
 */
export const ALLOWLIST = new Set([
  // Empty for now: report-only mode lists every finding as the baseline.
]);

/**
 * Files already moved onto the shared read handling (`useQueryView` /
 * `<QueryView>` in ui/src/components/QueryView.tsx). A finding in one of these
 * fails the check even in report-only mode, so a migrated surface cannot
 * quietly regress. Add a file here when you migrate it; mark an intentional
 * exception on its line with `// query-error-ok: <reason>`.
 */
export const ENFORCED_FILES = new Set([
  "ui/src/components/AgentChatPicker.tsx",
  "ui/src/components/AgentConversationSidebar.tsx",
  "ui/src/components/AgentConversationsSidebar.tsx",
  "ui/src/components/BreadcrumbBar.production.tsx",
  "ui/src/components/BreadcrumbBar.tsx",
  "ui/src/components/CaseRevisionRail.tsx",
  "ui/src/components/chat/AgentWorkPanels.tsx",
  "ui/src/components/FileViewerSheet.tsx",
  "ui/src/components/IssueRelatedWorkPanel.tsx",
  "ui/src/components/IssueShareSheet.tsx",
  "ui/src/components/issue-properties/external-object-rows.tsx",
  "ui/src/components/NewIssueDialog.tsx",
  "ui/src/components/QueryView.tsx",
  "ui/src/components/Sidebar.production.tsx",
  "ui/src/components/Sidebar.tsx",
  "ui/src/components/SidebarAgentChats.tsx",
  "ui/src/components/task-side-panel/TaskAttachmentPanel.tsx",
  "ui/src/components/task-side-panel/TaskDocumentPanel.tsx",
  "ui/src/components/task-side-panel/TaskSkillPanel.tsx",
  "ui/src/components/UnprefixedExecutionWorkspaceRedirect.tsx",
  "ui/src/components/WorkspaceFileBrowser.tsx",
  "ui/src/hooks/useIssueExternalObjects.ts",
  "ui/src/lib/query-client.ts",
  "ui/src/pages/AgentChat.tsx",
  "ui/src/pages/AgentChats.tsx",
  "ui/src/pages/AgentDetail.production.tsx",
  "ui/src/pages/AgentDetail.tsx",
  "ui/src/pages/CaseDetail.tsx",
  "ui/src/pages/CompanySettingsPluginPage.tsx",
  "ui/src/pages/ExecutionWorkspaceDetail.tsx",
  "ui/src/pages/GoalDetail.tsx",
  "ui/src/pages/IssueDetail.tsx",
  "ui/src/pages/PluginManager.tsx",
  "ui/src/pages/ProjectDetail.tsx",
  "ui/src/pages/ProjectWorkspaceDetail.tsx",
  "ui/src/pages/SkillStudio.tsx",
  "ui/src/pages/Workspaces.tsx",
  "ui/src/plugins/bridge.ts",
  "ui/src/plugins/launchers.tsx",
  "ui/src/plugins/slots.tsx",
]);

function isCheckable(path) {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.(test|spec|stories)\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  return true;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

/** Findings for one file's source text. Lines ending in `// query-error-ok` are skipped. */
export function scanSource(sourceText, path) {
  const findings = [];
  const lines = sourceText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\/\/\s*query-error-ok\b/.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ path, line: index + 1, rule: rule.id, text: trimmed });
    }
  }
  return findings;
}

export function scanQueryErrorRendering({
  root = defaultScanRoot,
  allowlist = ALLOWLIST,
  enforcedFiles = ENFORCED_FILES,
} = {}) {
  const findings = [];
  for (const file of walk(root, [])) {
    const path = relative(repoRoot, file).split(sep).join("/");
    for (const finding of scanSource(readFileSync(file, "utf8"), path)) {
      if (allowlist.has(`${finding.path}:${finding.rule}`)) continue;
      findings.push({ ...finding, enforced: enforcedFiles.has(finding.path) });
    }
  }
  return findings;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const enforce = args.has("--enforce");
  const summaryOnly = args.has("--summary");
  const findings = scanQueryErrorRendering();
  const enforcedFindings = findings.filter((finding) => finding.enforced);

  if (!summaryOnly) {
    for (const finding of findings) {
      console.log(`${finding.path}:${finding.line}  [${finding.rule}]  ${finding.text}`);
    }
  }
  const files = new Set(findings.map((finding) => finding.path));
  console.log("");
  console.log(`check-query-error-rendering: ${findings.length} finding(s) in ${files.size} file(s)`);
  for (const rule of RULES) {
    const count = findings.filter((finding) => finding.rule === rule.id).length;
    console.log(`  ${rule.id.padEnd(20)} ${String(count).padStart(5)}  ${rule.description}`);
  }
  if (enforcedFindings.length > 0) {
    // Always listed, even with --summary: these fail the check in every mode.
    console.log("");
    console.log(`${enforcedFindings.length} finding(s) in migrated files (ENFORCED_FILES); these always fail:`);
    for (const finding of enforcedFindings) {
      console.log(`  ${finding.path}:${finding.line}  [${finding.rule}]  ${finding.text}`);
    }
    console.log("Render cached data first and use describeError(), or mark the line with `// query-error-ok: <reason>`.");
    process.exitCode = 1;
  }
  if (!enforce) {
    console.log("Report-only mode: findings outside migrated files do not fail. Pass --enforce to fail on all findings.");
    return;
  }
  if (findings.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
