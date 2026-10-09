#!/usr/bin/env node
/**
 * Finish-line gate for the Task Chat Redesign (flag: enableTaskChatRedesign).
 *
 * 1. No hardcoded timing in the redesign surface: fails if any redesigned
 *    component/page contains a raw `<digits>ms` duration or a `cubic-bezier(`
 *    literal. All motion must reference the --motion-* tokens in
 *    ui/src/index.css (the single motion source), so the dev tweak panel can
 *    retune them live.
 *
 *    Documented allowlist: ui/src/components/task-chat/motion-tokens.ts is the
 *    easing-preset catalog the tweak panel offers — those cubic-bezier values
 *    are data for the tool, analogous to the token layer, not component motion.
 *    Test files are excluded.
 *
 * 2. Flag-off isolation seams are single conditionals (grep-provable): asserts
 *    the IssueDetail chat-tab seam and the IssueProperties tab-shell seam exist.
 *
 * Exit non-zero on any violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = ["ui/src/components/task-chat"];
const SCAN_FILES = [
  "ui/src/components/TaskChatThread.tsx",
  "ui/src/components/PropertiesPanel.tsx",
  "ui/src/components/TaskChatRedesignGate.tsx",
  "ui/src/pages/TaskChatLab.tsx",
  "ui/src/components/issue-properties/IssuePropertiesPlansTab.tsx",
  "ui/src/components/issue-properties/IssuePropertiesArtifactsTab.tsx",
];
const ALLOWLIST = new Set(["ui/src/components/task-chat/motion-tokens.ts"]);

const MS_RE = /\d+ms\b/;
const CUBIC_RE = /cubic-bezier\(/;

function isCheckable(path) {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.test\.(ts|tsx)$/.test(path)) return false;
  return true;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(join(repoRoot, d), files);
for (const f of SCAN_FILES) files.push(join(repoRoot, f));

const violations = [];
for (const file of files) {
  const rel = relative(repoRoot, file).split("\\").join("/");
  if (!isCheckable(rel) || ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (MS_RE.test(line) || CUBIC_RE.test(line)) {
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

// Seam assertions (clause B: single grep-provable conditional in each file).
const seams = [
  {
    file: "ui/src/pages/IssueDetail.tsx",
    needle: "? TaskChatThread : IssueChatThread",
    label: "chat-tab seam",
  },
  {
    file: "ui/src/components/issue-properties/IssueProperties.tsx",
    needle: "if (!taskChatRedesignEnabled) return propertiesBody;",
    label: "properties-pane seam",
  },
];
const missingSeams = [];
for (const seam of seams) {
  const text = readFileSync(join(repoRoot, seam.file), "utf8");
  if (!text.includes(seam.needle)) missingSeams.push(`${seam.label} (${seam.file})`);
}

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error("Hardcoded timing found in the task-chat redesign surface:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("Use a --motion-* token from ui/src/index.css instead.");
}
if (missingSeams.length > 0) {
  failed = true;
  console.error("Missing flag-off isolation seam(s):");
  for (const s of missingSeams) console.error(`  ${s}`);
}

if (failed) process.exit(1);
console.log(
  `check-task-chat-motion: OK (${files.filter((f) => isCheckable(relative(repoRoot, f).split("\\").join("/"))).length} files scanned, seams present).`,
);
