#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
const occurrences = [];
const ledgerPath = "doc/terminology/workspace-occurrence-ledger.md";

function category(file, line) {
  if (/^(packages\/db\/src\/migrations|doc\/plans|docs\/pr-screenshots|skills-releases|screenshots)\//.test(file)) return "historical";
  if (/pnpm-workspace|package(-lock)?\.json|pnpm-lock|google-workspace/i.test(`${file} ${line}`)) return "unrelated";
  if (/plugin-workspace-diff|workspace-diff|PAPERCLIP_[A-Z_]*WORKSPACE|\/api\/.*workspace|project\.workspaces|execution\.workspaces|enableIsolatedWorkspaces|workspace_(file|overview)|shared_workspace|isolated_workspace|project_workspace|execution_workspace|workspaces_overview|project\.workspaces\.read|execution\.workspaces\.read/i.test(`${file} ${line}`)) return "keep-contract";
  return "reviewed-residual";
}

for (const file of files) {
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/workspaces?/gi)) {
      occurrences.push({ file, line: index + 1, text: match[0], category: category(file, line) });
    }
  });
}

const displayFailures = [];
const fixDisplay = process.argv.includes("--fix-display");
const uiDisplaySource = (name) => {
  if (/^ui\/(?:src\/(?:components|pages)|storybook)\/.*\.tsx?$/.test(name)) return true;
  return /^ui\/src\/(?:lib|features|adapters)\/.*\.tsx?$/.test(name)
    && !/\.(?:test|spec)\.tsx?$/.test(name);
};

function isThirdPartyWorkspaceCopy(file, raw) {
  return (
    (file === "ui/src/pages/apps/AppsConnect.test.tsx" && /Workspace account/i.test(raw))
    || (file === "ui/src/lib/app-gallery-copy.ts" && /pages in your workspace/i.test(raw))
    || (file === "ui/src/adapters/grok-local/config-fields.tsx" && /Grok workspace/i.test(raw))
    || (file === "ui/src/adapters/codex-local/config-fields.tsx" && /Codex.*workspace/i.test(raw))
    || (file === "ui/src/features/connections/ConnectionSetupFlow.tsx" && /choose a workspace/i.test(raw))
  );
}

function isMachineBoundary(file, raw) {
  const importPath = /^["'`](?:\.{1,2}\/|@\/).*workspace/i.test(raw);
  const testOnlyHyphenatedIdentifier = /(?:\.test\.tsx|\/storybook\/)/.test(file)
    && /(?:workspace-|\-workspace)/i.test(raw);
  const classifierInput = file === "ui/src/lib/system-notice-humanizer.ts"
    && /workspace failed validation/i.test(raw);
  return importPath
    || isThirdPartyWorkspaceCopy(file, raw)
    || testOnlyHyphenatedIdentifier
    || classifierInput
    || />\{workspace\b|PAPERCLIP_|enableIsolatedWorkspaces|workspace[_:]|[_:]workspace|\/api\/|\/workspaces?(?:\/|[`'"}]|$)|execution-workspaces|project-workspace|workspace-diff|google workspace|notion workspace/i.test(raw);
}

function looksRenderedWorkspaceCopy(raw) {
  const visible = raw.replace(/\{[^}]*\}/g, "");
  return /\bWorkspace(s)?\b/.test(visible)
    || /\bworkspaces?\s+[a-z]/i.test(visible)
    || /[a-z]\s+workspaces?\b/i.test(visible);
}

const positiveControls = [
  ["ui/src/lib/example.ts", '"Open workspace"'],
  ["ui/src/features/example.tsx", '"Workspace-specific cleanup"'],
  ["ui/src/adapters/example.tsx", '"Repair this workspace"'],
];
for (const [file, raw] of positiveControls) {
  if (!uiDisplaySource(file) || isMachineBoundary(file, raw) || !looksRenderedWorkspaceCopy(raw)) {
    throw new Error(`Workspace terminology gate positive control failed: ${file}: ${raw}`);
  }
}

for (const file of files.filter(uiDisplaySource)) {
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  const lines = source.split("\n");
  lines.forEach((lineText, lineIndex) => {
    const candidates = [
      ...lineText.matchAll(/(["'`])(?:(?!\1).)*workspaces?(?:(?!\1).)*\1/gi),
      ...lineText.matchAll(/>[^<]*workspaces?[^<]*</gi),
    ];
    for (const candidate of candidates) {
      const raw = candidate[0];
      const machineBoundary = isMachineBoundary(file, raw);
      const looksRendered = looksRenderedWorkspaceCopy(raw);
      if (looksRendered && !machineBoundary) {
        if (!fixDisplay) displayFailures.push(`${file}:${lineIndex + 1}: ${raw.trim().slice(0, 160)}`);
      }
    }
  });
  if (fixDisplay) {
    const replaced = lines.map((lineText) => lineText.replace(
      /(["'`])(?:(?!\1).)*workspaces?(?:(?!\1).)*\1|>[^<]*workspaces?[^<]*</gi,
      (raw) => {
        const machineBoundary = isMachineBoundary(file, raw);
        const looksRendered = looksRenderedWorkspaceCopy(raw);
        if (!looksRendered || machineBoundary) return raw;
        return raw.replace(/\bWorkspaces\b/g, "Worktrees").replace(/\bWorkspace\b/g, "Worktree")
          .replace(/\bworkspaces\b/g, "worktrees").replace(/\bworkspace\b/g, "worktree");
      },
    )).join("\n");
    if (replaced !== source) writeFileSync(file, replaced);
  }
}

const counts = new Map();
for (const item of occurrences) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
counts.set("unclassified", displayFailures.length);

if (process.argv.includes("--write-ledger")) {
  const rows = ["unclassified", "keep-contract", "historical", "unrelated", "reviewed-residual"]
    .map((key) => `| ${key} | ${counts.get(key) ?? 0} |`).join("\n");
  const body = `# Workspace occurrence ledger\n\nGenerated by \`pnpm terminology:ledger\`. The Phase 1 rule is: persisted or process/network-bound names remain \`workspace\`; all other product terminology becomes \`worktree\`.\n\n| Classification | Occurrences |\n| --- | ---: |\n${rows}\n\nThe executable gate scans rendered UI and Storybook tokens and rejects every unclassified product-copy occurrence. Contract, historical, unrelated, and reviewed source/prose residuals are classified by the rules in \`scripts/check-worktree-terminology.mjs\`.\n`;
  writeFileSync(ledgerPath, body);
} else {
  const ledger = readFileSync(ledgerPath, "utf8");
  const recordedCounts = new Map(
    [...ledger.matchAll(/^\| ([a-z-]+) \| (\d+) \|$/gm)].map((match) => [match[1], Number(match[2])]),
  );
  const countDrift = ["unclassified", "keep-contract", "historical", "unrelated", "reviewed-residual"]
    .filter((key) => recordedCounts.get(key) !== (counts.get(key) ?? 0))
    .map((key) => `${key}: ledger=${recordedCounts.get(key) ?? "missing"}, current=${counts.get(key) ?? 0}`);
  if (countDrift.length) {
    console.error(
      `Workspace terminology ledger is stale. Review the changed occurrences, classify them in this script when needed, then run pnpm terminology:ledger:\n${countDrift.join("\n")}`,
    );
    process.exit(1);
  }
}

if (displayFailures.length) {
  console.error(`Unclassified rendered workspace terminology (${displayFailures.length}):\n${displayFailures.join("\n")}`);
  process.exit(1);
}
console.log(`Workspace terminology gate passed: 0 unclassified (${occurrences.length} classified occurrences).`);
