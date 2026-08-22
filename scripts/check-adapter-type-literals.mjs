#!/usr/bin/env node
/**
 * check-adapter-type-literals.mjs
 *
 * Architectural gate: shared code consumes declared adapter capabilities and
 * never branches on adapter identities. Adapter-type string literals (e.g.
 * "kimi_local") belong only in an adapter's own registration surfaces —
 * adapter packages, ui/src/adapters/<type>/, server/src/adapters/ — where
 * the adapter declares capabilities that shared code resolves generically
 * (UIAdapterModule.transcriptPresentation, acpx engine invocation config,
 * server registry entries). Identity checks in shared code do not scale to
 * many adapters and cannot work at all for externally-shipped plugin
 * adapters, which register at runtime.
 *
 * Detection is the union of two sources, so both current and future adapters
 * are covered:
 *  - the declared adapter types parsed from packages/shared/src/constants.ts
 *    (AGENT_ADAPTER_TYPES — the source of truth), and
 *  - the naming-convention suffixes every new adapter type uses
 *    (_local, _acp, _gateway, _cloud), which also covers types that have not
 *    been added to the shared list yet.
 * Three legacy names ("process", "http", "cursor") are excluded from literal
 * matching: as bare quoted strings they collide with URL schemes, CSS cursor
 * values, and the Node process — they cannot be scanned safely. All new
 * adapter types use suffixed names.
 *
 * Legacy files are ratcheted by BASELINE COUNT, not skipped: adding another
 * adapter-type literal to an allowlisted file fails the check. Baselines are
 * meant to only ever decrease as per-adapter tables migrate into adapter
 * descriptors.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Shared-code directories where adapter identities are forbidden. Adapter
// registration homes (ui/src/adapters/, server/src/adapters/, adapter
// packages) are intentionally NOT scanned.
export const DEFAULT_SCAN_DIRS = [
  "ui/src/lib",
  "ui/src/components",
  "packages/adapter-utils/src",
];

// Naming-convention suffixes for adapter types. Catches future adapter types
// before they land in the shared AGENT_ADAPTER_TYPES list.
export const ADAPTER_TYPE_SUFFIX_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:local|acp|gateway|cloud)$/;

// Legacy adapter-type names that cannot be literal-scanned safely: as bare
// quoted strings they collide with unrelated code ("http" URL schemes,
// "cursor" CSS values, "process" the Node global). New adapter types must use
// suffixed names, which the suffix pattern covers.
export const GENERIC_NAME_EXCLUSIONS = new Set([
  "process",
  "http",
  "cursor",
  // Not an adapter type: an error-code substring checked by the workspace
  // file browser ("no_local"). Matched by the _local suffix pattern only.
  "no_local",
]);

const QUOTED_LOWERCASE_RE = /["'`]([a-z][a-z0-9_]*)["'`]/g;

const SHARED_CONSTANTS_PATH = "packages/shared/src/constants.ts";

// LEGACY DEBT — baselines may only decrease. Each entry is the exact
// per-identity occurrence count the file carried when this gate landed (the
// full multiset). Any per-identity increase fails — a new identity, an
// equal-count swap, and one-more-of-an-allowed-identity are all violations.
// When a table migrates into adapter descriptors, lower (or delete) its
// baseline.
export const LEGACY_BASELINES = new Map([
  ["packages/adapter-utils/src/session-compaction.ts", { claude_local: 1, codex_local: 1, cursor_cloud: 1, gemini_local: 1, hermes_local: 1, opencode_local: 1, pi_local: 1 }],
  ["ui/src/components/agent-config-defaults.ts", { claude_local: 1 }],
  ["ui/src/components/AgentConfigForm.tsx", { claude_local: 2, codex_local: 8, cursor_cloud: 1, gemini_local: 3, opencode_local: 14 }],
  ["ui/src/components/ConfigureBuiltInAgentModal.tsx", { codex_local: 1, hermes_gateway: 1, openclaw_gateway: 1, opencode_local: 1 }],
  ["ui/src/components/issue-properties/helpers.ts", { codex_local: 3, opencode_local: 3 }],
  ["ui/src/components/issue-properties/IssueProperties.tsx", { claude_local: 3, codex_local: 1, opencode_local: 1 }],
  ["ui/src/components/NewIssueDialog.tsx", { claude_local: 2, codex_local: 3, opencode_local: 3 }],
  ["ui/src/components/OnboardingWizard.tsx", { claude_local: 6, codex_local: 7, gemini_local: 8, openclaw_gateway: 3, opencode_local: 14, pi_local: 1 }],
  ["ui/src/lib/agent-onboarding-prompt.ts", { hermes_gateway: 1, openclaw_gateway: 1 }],
  ["ui/src/lib/issue-assignee-overrides.ts", { claude_local: 3, codex_local: 2, opencode_local: 2 }],
]);

/**
 * Parse the declared adapter types from packages/shared/src/constants.ts.
 * Returns [] when the file or the array is missing (fixture roots in tests);
 * the suffix pattern still applies there.
 */
export function loadDeclaredAdapterTypes(root = repoRoot) {
  let source;
  try {
    source = readFileSync(join(root, SHARED_CONSTANTS_PATH), "utf8");
  } catch {
    return [];
  }

  const arrayMatch = source.match(/export const AGENT_ADAPTER_TYPES = \[([\s\S]*?)\] as const;/);
  if (!arrayMatch) return [];

  return [...arrayMatch[1].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((m) => m[1]);
}

export function buildAdapterTypeMatcher(declaredTypes) {
  const declared = new Set(
    declaredTypes.filter((type) => !GENERIC_NAME_EXCLUSIONS.has(type)),
  );
  return (literal) => {
    if (GENERIC_NAME_EXCLUSIONS.has(literal)) return false;
    return declared.has(literal) || ADAPTER_TYPE_SUFFIX_RE.test(literal);
  };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isSourceFile(name) {
  if (name.includes(".test.") || name.includes(".stories.")) return false;
  return [...SOURCE_EXTENSIONS].some((ext) => name.endsWith(ext));
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function scanForAdapterTypeLiterals({
  root = repoRoot,
  scanDirs = DEFAULT_SCAN_DIRS,
  legacyBaselines = LEGACY_BASELINES,
  declaredTypes = loadDeclaredAdapterTypes(root),
} = {}) {
  const isAdapterTypeLiteral = buildAdapterTypeMatcher(declaredTypes);
  const violations = [];
  const legacyOverages = [];
  const legacyImprovements = [];

  for (const scanDir of scanDirs) {
    for (const file of walk(join(root, scanDir))) {
      const relPath = relative(root, file).replace(/\\/g, "/");
      const lines = readFileSync(file, "utf8").split("\n");

      const hits = [];
      for (let index = 0; index < lines.length; index += 1) {
        for (const match of lines[index].matchAll(QUOTED_LOWERCASE_RE)) {
          if (isAdapterTypeLiteral(match[1])) {
            hits.push({ file: relPath, line: index + 1, literal: match[1] });
          }
        }
      }
      if (hits.length === 0) continue;

      const fileBaseline = legacyBaselines.get(relPath);
      if (fileBaseline === undefined) {
        violations.push(...hits);
        continue;
      }
      // Per-identity ratchet: any occurrence beyond that identity's baseline
      // count in this file is a violation — a brand-new identity, an
      // equal-count swap, and one-more-of-an-allowed-identity all fail. Hits
      // are counted in file order, so the surplus occurrences are reported
      // with their exact lines.
      const seen = {};
      let improved = false;
      for (const hit of hits) {
        seen[hit.literal] = (seen[hit.literal] ?? 0) + 1;
        if (seen[hit.literal] > (fileBaseline[hit.literal] ?? 0)) {
          legacyOverages.push({
            file: relPath,
            literal: hit.literal,
            line: hit.line,
            baseline: fileBaseline[hit.literal] ?? 0,
          });
        }
      }
      for (const [literal, allowed] of Object.entries(fileBaseline)) {
        if ((seen[literal] ?? 0) < allowed) improved = true;
      }
      if (improved && !hits.some((hit) => seen[hit.literal] > (fileBaseline[hit.literal] ?? 0))) {
        legacyImprovements.push({ file: relPath });
      }
    }
  }

  return { violations, legacyOverages, legacyImprovements };
}

function main() {
  const { violations, legacyOverages, legacyImprovements } = scanForAdapterTypeLiterals();

  for (const improvement of legacyImprovements) {
    console.log(
      `Note: ${improvement.file} is below its legacy baseline — lower the baseline in scripts/check-adapter-type-literals.mjs to lock in the improvement.`,
    );
  }

  if (violations.length === 0 && legacyOverages.length === 0) {
    console.log("Adapter-type literal check OK: shared code carries no new adapter identities.");
    return;
  }

  if (violations.length > 0) {
    console.error("Adapter-type literals found in shared code:\n");
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}: "${violation.literal}"`);
    }
  }
  if (legacyOverages.length > 0) {
    console.error("\nOccurrences beyond a legacy file's per-identity baseline (the baseline only ratchets down):");
    for (const overage of legacyOverages) {
      console.error(
        `  ${overage.file}:${overage.line}: "${overage.literal}" (baseline ${overage.baseline})`,
      );
    }
  }
  console.error(
    [
      "",
      "Shared code must not branch on adapter identities — it consumes capabilities",
      "that adapters declare where they register:",
      "  - UI rendering: declare hints on the adapter's UIAdapterModule",
      "    (e.g. transcriptPresentation) and resolve them via findUIAdapter().",
      "  - acpx engine behavior: set invocation-config keys from the adapter's",
      "    acpx config builder (e.g. summaryStrategy).",
      "  - Server behavior: extend the adapter's server registry entry.",
      "Identity checks cannot work for externally-shipped plugin adapters, which",
      "register at runtime.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main();
}
