#!/usr/bin/env node
/**
 * codemod-extract-colors.mjs
 *
 * Phase 2 (extraction), Batch 1/4 of the design-token audit
 * (branch design/token-extraction). Replaces hardcoded COLOR literals
 * (hex / rgb() / rgba() / hsl() / hsla() / oklch()) in Tailwind class
 * strings and inline style objects, in `ui/src/components/**` and
 * `ui/src/pages/**` (including their *.test.tsx companions), with
 * references to CSS custom-property tokens defined in `ui/src/index.css`.
 *
 * Scope is deliberately a fixed, manually-audited SITE TABLE rather than a
 * blind hex-matching regex sweep: a generic `#[0-9a-f]{3,8}` regex produces
 * false positives on this codebase (issue references like "acme/web#241",
 * PR/comment numbers like "React #10140", etc.). Every entry below was
 * verified by hand against TOKEN-AUDIT.md section 1 (see repo root) to
 * confirm it is (a) a real color value, (b) consumed as a rendered CSS
 * value (not fed into contrast math, canvas painting, or persisted /
 * compared JS state), and (c) safe to swap for `var(--token)` without any
 * visual difference.
 *
 * Idempotent: every site's `find` string is the ORIGINAL literal-bearing
 * form; once rewritten the file no longer contains that string, so
 * re-running the script is a no-op (each replace() call only fires if the
 * exact original substring is still present).
 *
 * Usage: node scripts/codemod-extract-colors.mjs [--check]
 *   --check   Report what WOULD change without writing files (dry run).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");

const DRY_RUN = process.argv.includes("--check");

/**
 * Token table — every new token minted by this batch, value VERBATIM.
 * `name` is the CSS custom-property name (without leading --).
 * `value` is the exact literal value from the source site.
 * `comment` documents where it came from / why, emitted above the
 * declaration in ui/src/index.css.
 */
const NEW_TOKENS = [
  // --- Tailwind bracket color-class hex sites (section: bracket hex) ---
  { name: "hex-959596", value: "#959596", comment: "Muted feed actor/verb/title text (ActivityFeed.tsx, FeedCard.tsx) — PRIOR-ART-flagged gap cluster, no existing token match." },
  { name: "hex-1d1d1d", value: "#1d1d1d", comment: "OnboardingWizard.tsx dark decorative panel background, singleton." },

  // --- OrgChart.tsx status dot colors (independent from --status-agent-* hues) ---
  { name: "hex-22d3ee", value: "#22d3ee", comment: "OrgChart.tsx agent status dot — 'running' (independent palette from --status-agent-*, see TOKEN-AUDIT.md 1.2)." },
  { name: "hex-4ade80", value: "#4ade80", comment: "OrgChart.tsx agent status dot — 'active'." },
  { name: "hex-facc15", value: "#facc15", comment: "OrgChart.tsx agent status dot — 'paused' / 'idle' (shared value)." },
  { name: "hex-f87171", value: "#f87171", comment: "OrgChart.tsx agent status dot — 'error'." },
  { name: "hex-a3a3a3", value: "#a3a3a3", comment: "OrgChart.tsx agent status dot — 'terminated' + defaultDotColor fallback." },

  // --- ActivityCharts.tsx priority + status color maps (independent palette, see TOKEN-AUDIT.md 1.2) ---
  { name: "hex-ef4444", value: "#ef4444", comment: "ActivityCharts.tsx — priority 'critical' + status 'blocked' (shared value); also the <0.5 success-rate bar tint." },
  { name: "hex-f97316", value: "#f97316", comment: "ActivityCharts.tsx — priority 'high'." },
  { name: "hex-eab308", value: "#eab308", comment: "ActivityCharts.tsx — priority 'medium'; also the 0.5-0.8 success-rate bar tint." },
  { name: "hex-6b7280", value: "#6b7280", comment: "ActivityCharts.tsx — priority 'low' + status 'cancelled' + statusColors fallback (shared value)." },
  { name: "hex-3b82f6", value: "#3b82f6", comment: "ActivityCharts.tsx — status 'todo' (independent from --status-task-todo which is #f59e0b)." },
  { name: "hex-8b5cf6", value: "#8b5cf6", comment: "ActivityCharts.tsx — status 'in_progress' (independent from --status-task-in_progress which is #2563eb — flagged inconsistency, TOKEN-AUDIT.md 1.2)." },
  { name: "hex-a855f7", value: "#a855f7", comment: "ActivityCharts.tsx — status 'in_review'." },
  { name: "hex-10b981", value: "#10b981", comment: "ActivityCharts.tsx — status 'done'; also the >=0.8 success-rate bar tint." },
  { name: "hex-64748b", value: "#64748b", comment: "ActivityCharts.tsx status 'backlog'; also the widely-repeated 'no project assigned' muted-slate fallback color (TOKEN-AUDIT.md 1.3) across Routines/MarkdownEditor/RoutineRunVariablesDialog/RoutineList/IssueColumns/editable-sections." },

  // --- Project-color-fallback indigo cluster (TOKEN-AUDIT.md 1.3) ---
  { name: "hex-6366f1", value: "#6366f1", comment: "Project-color-fallback indigo seed default (ProjectDetail/PipelineSettings/IssueProperties/NewIssueDialog) — new-project-color-picker-seed family per TOKEN-AUDIT.md 1.3." },

  // --- Gradient tokens (verbatim, one per distinct gradient string; DESIGN.md: mint, don't collapse) ---
  { name: "gradient-extract-1", value: "linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))", comment: "Dashboard.tsx budget-alert card gradient." },
  { name: "gradient-extract-2", value: "linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))", comment: "Costs.tsx subtle white card gradient." },
  { name: "gradient-extract-3", value: "radial-gradient(circle at top left,rgba(244,114,182,0.08),transparent 35%),radial-gradient(circle at bottom right,rgba(56,189,248,0.1),transparent 32%)", comment: "AccountingModelCard.tsx decorative overlay." },
  { name: "gradient-extract-4", value: "linear-gradient(180deg,rgba(255,70,70,0.10),rgba(255,255,255,0.02))", comment: "BudgetIncidentCard.tsx incident-card gradient." },
  { name: "gradient-extract-5", value: "radial-gradient(circle at top left,rgba(8,145,178,0.08),transparent 36%),radial-gradient(circle at bottom right,rgba(245,158,11,0.10),transparent 28%)", comment: "RunTranscriptUxLab.tsx:78 hero gradient." },
  { name: "gradient-extract-6", value: "linear-gradient(135deg,rgba(8,145,178,0.08),transparent 28%),linear-gradient(180deg,rgba(245,158,11,0.08),transparent 40%),var(--background)", comment: "RunTranscriptUxLab.tsx:203 hero-card gradient." },
  { name: "gradient-extract-7", value: "radial-gradient(circle at top right,rgba(255,255,255,0.22),transparent 34%),radial-gradient(circle at bottom left,rgba(255,255,255,0.08),transparent 36%)", comment: "ProfileSettings.tsx:162 decorative overlay." },
  { name: "gradient-extract-8", value: "radial-gradient(circle at top,rgba(8,145,178,0.18),transparent 48%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,1))", comment: "InviteUxLab.tsx:510 dark hero gradient." },
  { name: "gradient-extract-9", value: "linear-gradient(135deg,rgba(8,145,178,0.10),transparent 28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent 44%),var(--background)", comment: "IssueChatUxLab.tsx:139 + InviteUxLab.tsx:700 hero-card gradient (identical string, 2 sites)." },
  { name: "gradient-extract-10", value: "linear-gradient(180deg,rgba(168,85,247,0.06),transparent 28%),var(--background)", comment: "IssueChatUxLab.tsx:203 + InviteUxLab.tsx:909 accent gradient (identical string, 2 sites)." },
  { name: "gradient-extract-11", value: "linear-gradient(180deg,rgba(16,185,129,0.06),transparent 28%),var(--background)", comment: "IssueChatUxLab.tsx:226 accent gradient." },
  { name: "gradient-extract-12", value: "linear-gradient(180deg,rgba(6,182,212,0.05),transparent 28%),var(--background)", comment: "IssueChatUxLab.tsx:263 accent gradient." },
  { name: "gradient-extract-13", value: "linear-gradient(180deg,rgba(59,130,246,0.06),transparent 28%),var(--background)", comment: "IssueChatUxLab.tsx:294 accent gradient." },
  { name: "gradient-extract-14", value: "linear-gradient(180deg,rgba(168,85,247,0.05),transparent 26%),var(--background)", comment: "IssueChatUxLab.tsx:315 accent gradient." },
  { name: "gradient-extract-15", value: "linear-gradient(180deg,rgba(245,158,11,0.08),transparent 26%),var(--background)", comment: "IssueChatUxLab.tsx:339 accent gradient." },
  { name: "gradient-extract-16", value: "linear-gradient(135deg,rgba(245,158,11,0.10),transparent 28%),linear-gradient(180deg,rgba(8,145,178,0.08),transparent 44%),var(--background)", comment: "SystemNoticeUxLab.tsx:140 hero-card gradient." },
  { name: "gradient-extract-17", value: "linear-gradient(180deg,rgba(245,158,11,0.05),transparent 28%),var(--background)", comment: "SystemNoticeUxLab.tsx:193 accent gradient." },
  { name: "gradient-extract-18", value: "linear-gradient(180deg,rgba(8,145,178,0.05),transparent 28%),var(--background)", comment: "SystemNoticeUxLab.tsx:225 accent gradient." },
  { name: "gradient-extract-19", value: "linear-gradient(180deg,rgba(244,63,94,0.05),transparent 28%),var(--background)", comment: "SystemNoticeUxLab.tsx:289 accent gradient." },
  { name: "gradient-extract-20", value: "linear-gradient(180deg,rgba(16,185,129,0.05),transparent 28%),var(--background)", comment: "SystemNoticeUxLab.tsx:331 accent gradient." },
  { name: "gradient-extract-21", value: "linear-gradient(180deg,rgba(59,130,246,0.05),transparent 30%),var(--background)", comment: "InviteUxLab.tsx:753 accent gradient." },
  { name: "gradient-extract-22", value: "linear-gradient(180deg,rgba(234,179,8,0.06),transparent 28%),var(--background)", comment: "InviteUxLab.tsx:807 accent gradient." },
  { name: "gradient-extract-23", value: "linear-gradient(180deg,rgba(16,185,129,0.06),transparent 30%),var(--background)", comment: "InviteUxLab.tsx:884 accent gradient." },
  { name: "gradient-extract-24", value: "linear-gradient(180deg,rgba(244,114,182,0.06),transparent 28%),var(--background)", comment: "InviteUxLab.tsx:921 accent gradient." },
];

/**
 * Existing-token reuse map — hardcoded value -> existing index.css token,
 * used ONLY where the value exact-matches (case-insensitive) a token whose
 * value is IDENTICAL in :root and .dark (mode-independent brand tier per
 * DESIGN.md). Both matches found in this batch are status hues with no
 * `.dark` override in index.css.
 */
const REUSE = {
  "#2563EB": "var(--status-task-in_progress)", // == --status-agent-running, both #2563eb, mode-independent
  "#22c55e": "var(--status-task-done)",
};

/**
 * SITE TABLE — [relative file path, find, replace]. Order-independent;
 * every find/replace pair is applied with a single non-global `.replace()`
 * per occurrence count noted, so duplicate literal strings within one file
 * (e.g. the three `text-[#959596]` in ActivityFeed.tsx) are handled via
 * `replaceAll` where explicitly marked.
 */
const SITES = [
  // ── Tailwind bracket hex-class sites ──────────────────────────────
  {
    file: "components/ActivityFeed.tsx",
    replaceAll: [
      ['className="font-medium text-[#959596] group-hover:text-white"', 'className="font-medium text-(--hex-959596) group-hover:text-white"'],
      ['className="ml-1 text-[#959596]"', 'className="ml-1 text-(--hex-959596)"'],
      ['className="ml-1 text-[#959596] group-hover:text-white"', 'className="ml-1 text-(--hex-959596) group-hover:text-white"'],
    ],
  },
  {
    file: "components/FeedCard.tsx",
    replaceAll: [
      ['isMuted ? "text-muted-foreground/70" : "text-[#959596]"', 'isMuted ? "text-muted-foreground/70" : "text-(--hex-959596)"'],
    ],
  },
  {
    file: "components/OnboardingWizard.tsx",
    replaceAll: [
      ['"hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out"', '"hidden md:block overflow-hidden bg-(--hex-1d1d1d) transition-[width,opacity] duration-500 ease-in-out"'],
    ],
  },
  {
    file: "components/IssueChatThread.tsx",
    replaceAll: [
      ['// Liveness blue (#2563EB) for the human\'s own messages (PAP-95 rev 5).', '// Liveness blue (--status-task-in_progress) for the human\'s own messages (PAP-95 rev 5).'],
      ['? "bg-[#2563EB] text-white"', '? "bg-(--status-task-in_progress) text-white"'],
    ],
  },
  {
    file: "components/IssueChatThread.test.tsx",
    replaceAll: [
      ['expect(bubble?.className).not.toContain("bg-[#2563EB]");', 'expect(bubble?.className).not.toContain("bg-(--status-task-in_progress)");'],
    ],
  },

  // ── OrgChart.tsx status dot color map (pure style render) ─────────
  {
    file: "pages/OrgChart.tsx",
    replaceAll: [
      ['running: "#22d3ee",', 'running: "var(--hex-22d3ee)",'],
      ['active: "#4ade80",', 'active: "var(--hex-4ade80)",'],
      ['paused: "#facc15",\n  idle: "#facc15",', 'paused: "var(--hex-facc15)",\n  idle: "var(--hex-facc15)",'],
      ['error: "#f87171",', 'error: "var(--hex-f87171)",'],
      ['terminated: "#a3a3a3",', 'terminated: "var(--hex-a3a3a3)",'],
      ['const defaultDotColor = "#a3a3a3";', 'const defaultDotColor = "var(--hex-a3a3a3)";'],
    ],
  },

  // ── ActivityCharts.tsx priority + status color maps (pure style render) ──
  {
    file: "components/ActivityCharts.tsx",
    replaceAll: [
      ['critical: "#ef4444",', 'critical: "var(--hex-ef4444)",'],
      ['high: "#f97316",', 'high: "var(--hex-f97316)",'],
      ['medium: "#eab308",', 'medium: "var(--hex-eab308)",'],
      ['low: "#6b7280",', 'low: "var(--hex-6b7280)",'],
      ['todo: "#3b82f6",', 'todo: "var(--hex-3b82f6)",'],
      ['in_progress: "#8b5cf6",', 'in_progress: "var(--hex-8b5cf6)",'],
      ['in_review: "#a855f7",', 'in_review: "var(--hex-a855f7)",'],
      ['done: "#10b981",', 'done: "var(--hex-10b981)",'],
      ['blocked: "#ef4444",', 'blocked: "var(--hex-ef4444)",'],
      ['cancelled: "#6b7280",', 'cancelled: "var(--hex-6b7280)",'],
      ['backlog: "#64748b",', 'backlog: "var(--hex-64748b)",'],
      ['backgroundColor: statusColors[s] ?? "#6b7280"', 'backgroundColor: statusColors[s] ?? "var(--hex-6b7280)"'],
      ['color: statusColors[s] ?? "#6b7280"', 'color: statusColors[s] ?? "var(--hex-6b7280)"'],
      ['rate >= 0.8 ? "#10b981" : rate >= 0.5 ? "#eab308" : "#ef4444"', 'rate >= 0.8 ? "var(--hex-10b981)" : rate >= 0.5 ? "var(--hex-eab308)" : "var(--hex-ef4444)"'],
    ],
  },

  // ── Project-color-fallback pure-style-render sites (indigo #6366f1) ──
  {
    file: "pages/ProjectDetail.tsx",
    replaceAll: [
      ['backgroundColor: project.color ?? "#6366f1"', 'backgroundColor: project.color ?? "var(--hex-6366f1)"'],
    ],
  },
  {
    file: "pages/PipelineSettings.tsx",
    replaceAll: [
      ['backgroundColor: selectedAutomationProject.color ?? "#6366f1"', 'backgroundColor: selectedAutomationProject.color ?? "var(--hex-6366f1)"'],
      ['backgroundColor: project?.color ?? "#6366f1"', 'backgroundColor: project?.color ?? "var(--hex-6366f1)"'],
    ],
  },
  {
    file: "components/issue-properties/IssueProperties.tsx",
    replaceAll: [
      ['backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "#6366f1"', 'backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "var(--hex-6366f1)"'],
      ['backgroundColor: option.color ?? "#6366f1"', 'backgroundColor: option.color ?? "var(--hex-6366f1)"'],
    ],
  },
  {
    file: "components/NewIssueDialog.tsx",
    replaceAll: [
      ['backgroundColor: currentProject.color ?? "#6366f1"', 'backgroundColor: currentProject.color ?? "var(--hex-6366f1)"'],
      ['backgroundColor: project?.color ?? "#6366f1"', 'backgroundColor: project?.color ?? "var(--hex-6366f1)"'],
    ],
  },

  // ── Project-color-fallback pure-style-render sites (slate #64748b) ──
  {
    file: "pages/Routines.tsx",
    replaceAll: [
      ['backgroundColor: currentProject.color ?? "#64748b"', 'backgroundColor: currentProject.color ?? "var(--hex-64748b)"'],
      ['backgroundColor: project?.color ?? "#64748b"', 'backgroundColor: project?.color ?? "var(--hex-64748b)"'],
    ],
  },
  {
    file: "components/MarkdownEditor.tsx",
    replaceAll: [
      ['backgroundColor: option.projectColor ?? "#64748b"', 'backgroundColor: option.projectColor ?? "var(--hex-64748b)"'],
    ],
  },
  {
    file: "components/RoutineRunVariablesDialog.tsx",
    replaceAll: [
      ['backgroundColor: selectedProject.color ?? "#64748b"', 'backgroundColor: selectedProject.color ?? "var(--hex-64748b)"'],
      ['backgroundColor: project?.color ?? "#64748b"', 'backgroundColor: project?.color ?? "var(--hex-64748b)"'],
    ],
  },
  {
    file: "components/RoutineList.tsx",
    replaceAll: [
      ['backgroundColor: project?.color ?? "#64748b"', 'backgroundColor: project?.color ?? "var(--hex-64748b)"'],
    ],
  },
  {
    file: "components/routine-sections/editable-sections.tsx",
    replaceAll: [
      ['backgroundColor: currentProject.color ?? "#64748b"', 'backgroundColor: currentProject.color ?? "var(--hex-64748b)"'],
      ['backgroundColor: project?.color ?? "#64748b"', 'backgroundColor: project?.color ?? "var(--hex-64748b)"'],
    ],
  },

  // ── Gradient sites (verbatim value -> --gradient-extract-N token) ─
  {
    file: "pages/Dashboard.tsx",
    replaceAll: [
      ['bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))]', 'bg-(image:--gradient-extract-1)'],
    ],
  },
  {
    file: "pages/Costs.tsx",
    replaceAll: [
      ['bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))]', 'bg-(image:--gradient-extract-2)'],
    ],
  },
  {
    file: "components/AccountingModelCard.tsx",
    replaceAll: [
      ['bg-[radial-gradient(circle_at_top_left,rgba(244,114,182,0.08),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.1),transparent_32%)]', 'bg-(image:--gradient-extract-3)'],
    ],
  },
  {
    file: "components/BudgetIncidentCard.tsx",
    replaceAll: [
      ['bg-[linear-gradient(180deg,rgba(255,70,70,0.10),rgba(255,255,255,0.02))]', 'bg-(image:--gradient-extract-4)'],
    ],
  },
  {
    file: "pages/RunTranscriptUxLab.tsx",
    replaceAll: [
      ['bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.08),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(245,158,11,0.10),transparent_28%)]', 'bg-(image:--gradient-extract-5)'],
      ['bg-[linear-gradient(135deg,rgba(8,145,178,0.08),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.08),transparent_40%),var(--background)]', 'bg-(image:--gradient-extract-6)'],
    ],
  },
  {
    file: "pages/ProfileSettings.tsx",
    replaceAll: [
      ['bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.22),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.08),transparent_36%)]', 'bg-(image:--gradient-extract-7)'],
    ],
  },
  {
    file: "pages/InviteUxLab.tsx",
    replaceAll: [
      ['bg-[radial-gradient(circle_at_top,rgba(8,145,178,0.18),transparent_48%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,1))]', 'bg-(image:--gradient-extract-8)'],
      ['bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)]', 'bg-(image:--gradient-extract-9)'],
      ['bg-[linear-gradient(180deg,rgba(59,130,246,0.05),transparent_30%),var(--background)]', 'bg-(image:--gradient-extract-21)'],
      ['bg-[linear-gradient(180deg,rgba(234,179,8,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-22)'],
      ['bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_30%),var(--background)]', 'bg-(image:--gradient-extract-23)'],
      ['bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-10)'],
      ['bg-[linear-gradient(180deg,rgba(244,114,182,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-24)'],
    ],
  },
  {
    file: "pages/IssueChatUxLab.tsx",
    replaceAll: [
      ['bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)]', 'bg-(image:--gradient-extract-9)'],
      ['bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-10)'],
      ['bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-11)'],
      ['bg-[linear-gradient(180deg,rgba(6,182,212,0.05),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-12)'],
      ['bg-[linear-gradient(180deg,rgba(59,130,246,0.06),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-13)'],
      ['bg-[linear-gradient(180deg,rgba(168,85,247,0.05),transparent_26%),var(--background)]', 'bg-(image:--gradient-extract-14)'],
      ['bg-[linear-gradient(180deg,rgba(245,158,11,0.08),transparent_26%),var(--background)]', 'bg-(image:--gradient-extract-15)'],
    ],
  },
  {
    file: "pages/SystemNoticeUxLab.tsx",
    replaceAll: [
      ['bg-[linear-gradient(135deg,rgba(245,158,11,0.10),transparent_28%),linear-gradient(180deg,rgba(8,145,178,0.08),transparent_44%),var(--background)]', 'bg-(image:--gradient-extract-16)'],
      ['bg-[linear-gradient(180deg,rgba(245,158,11,0.05),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-17)'],
      ['bg-[linear-gradient(180deg,rgba(8,145,178,0.05),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-18)'],
      ['bg-[linear-gradient(180deg,rgba(244,63,94,0.05),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-19)'],
      ['bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent_28%),var(--background)]', 'bg-(image:--gradient-extract-20)'],
    ],
  },
];

// ── Allowlist — sites intentionally NOT rewritten (functional / third-party) ──
// One entry per file; each also gets an inline
// `/* token-extraction: allowlisted — ... */` comment injected at the site
// (idempotent: only injected if not already present).
const ALLOWLIST_COMMENTS = [
  {
    file: "pages/CompanyEnvironments.tsx",
    anchor: 'background: "#0a0a0a",',
    commentLine: "        // token-extraction: allowlisted — xterm.js terminal theme config; functional third-party option object, not a rendered CSS value.",
  },
  {
    file: "pages/CompanySettings.tsx",
    anchor: '                  <input\n                    type="color"',
    commentLine: "                  {/* token-extraction: allowlisted — <input type=\"color\"> value must be a real hex string, not a var() reference. */}",
  },
  {
    file: "components/issue-properties/IssueProperties.tsx",
    anchor: 'const [newLabelColor, setNewLabelColor] = useState("#6366f1");',
    commentLine: "  // token-extraction: allowlisted — color-picker seed state, persisted into label-create payload; a var() string would break that payload.",
  },
  {
    file: "pages/CompanySkills.tsx",
    anchor: "const DISCOVERY_ACCENTS = [",
    commentLine: "// token-extraction: allowlisted — skill.color is persisted/compared JS data (SkillCreateDraft), not just a rendered value; a var() string would corrupt it.",
  },
  {
    file: "components/IssueColumns.tsx",
    anchor: 'const accentColor = projectColor ?? "#64748b";',
    commentLine: "            // token-extraction: allowlisted — accentColor also feeds pickTextColorForPillBg() contrast math; a var() string can't be parsed as a hex color there.",
  },
  {
    file: "components/CompanyPatternIcon.tsx",
    anchor: "ctx.fillStyle = `rgb(${offR} ${offG} ${offB})`;",
    commentLine: "  // token-extraction: allowlisted — canvas 2D fillStyle computed at runtime from numeric channel props; not a static literal.",
  },
  {
    file: "components/FileViewerSheet.tsx",
    anchor: 'isHighlighted && "bg-[var(--paperclip-code-highlight-bg,rgba(250,204,21,0.12))]",',
    commentLine: "                // token-extraction: allowlisted — half-migrated var(--x, fallback) pattern; --paperclip-code-highlight-bg/-border don't exist in index.css yet. Needs human decision (see TOKEN-AUDIT.md 2) before minting, since defining the var changes a fallback-CSS-var-expression, not a plain literal swap.",
  },
  {
    file: "pages/InviteUxLab.tsx",
    anchor: '      <div className="flex items-start gap-4">\n        <CompanyPatternIcon\n          companyName="Acme Robotics"\n          logoUrl="/api/invites/pcp_invite_test/logo"\n          brandColor="#114488"\n          className="h-16 w-16 rounded-none border border-zinc-800"',
    commentLine: "      {/* token-extraction: allowlisted — brandColor feeds CompanyPatternIcon's hexToHue() color math via a canvas fill; demo/showcase-only prop, not a rendered CSS value. */}",
  },
  {
    file: "pages/InviteUxLab.tsx",
    anchor: '      <div className="flex items-center gap-3">\n        <CompanyPatternIcon\n          companyName="Acme Robotics"\n          logoUrl="/api/invites/pcp_invite_test/logo"\n          brandColor="#114488"\n          className="h-12 w-12 rounded-none border border-zinc-800"',
    commentLine: "      {/* token-extraction: allowlisted — brandColor feeds CompanyPatternIcon's hexToHue() color math via a canvas fill; demo/showcase-only prop, not a rendered CSS value. */}",
  },
];

function applyReplacements(content, pairs, filePath) {
  let next = content;
  let count = 0;
  for (const [find, replace] of pairs) {
    if (next.includes(find)) {
      next = next.split(find).join(replace);
      count += 1;
    } else if (!next.includes(replace)) {
      // Neither the original nor the replacement is present — likely a
      // stale site table entry; flag loudly rather than silently no-op.
      console.warn(`  ! WARNING: pattern not found (and not already applied) in ${filePath}:\n    ${find.slice(0, 100)}`);
    }
  }
  return { next, count };
}

function injectAllowlistComment(content, anchor, commentLine, filePath) {
  if (content.includes(commentLine.trim())) return { next: content, injected: false }; // idempotent
  const idx = content.indexOf(anchor);
  if (idx === -1) {
    console.warn(`  ! WARNING: allowlist anchor not found in ${filePath}:\n    ${anchor}`);
    return { next: content, injected: false };
  }
  const lineStart = content.lastIndexOf("\n", idx) + 1;
  const next = content.slice(0, lineStart) + commentLine + "\n" + content.slice(lineStart);
  return { next, injected: true };
}

function main() {
  let totalSitesRewritten = 0;
  let filesChanged = 0;
  const changedFiles = [];

  for (const site of SITES) {
    const filePath = resolve(UI_SRC, site.file);
    const original = readFileSync(filePath, "utf8");
    const { next, count } = applyReplacements(original, site.replaceAll, site.file);
    if (next !== original) {
      filesChanged += 1;
      changedFiles.push(site.file);
      if (!DRY_RUN) writeFileSync(filePath, next, "utf8");
    }
    totalSitesRewritten += count;
  }

  let allowlistInjections = 0;
  for (const entry of ALLOWLIST_COMMENTS) {
    const filePath = resolve(UI_SRC, entry.file);
    const original = readFileSync(filePath, "utf8");
    const { next, injected } = injectAllowlistComment(original, entry.anchor, entry.commentLine, entry.file);
    if (injected) {
      allowlistInjections += 1;
      if (!DRY_RUN) writeFileSync(filePath, next, "utf8");
      if (!changedFiles.includes(entry.file)) {
        filesChanged += 1;
        changedFiles.push(entry.file);
      }
    }
  }

  // ── index.css token block ──────────────────────────────────────────
  const cssPath = resolve(UI_SRC, "index.css");
  const cssOriginal = readFileSync(cssPath, "utf8");
  const marker = "/* ── Extracted verbatim tokens (Phase 2, design/token-extraction) ── */";
  let cssNext = cssOriginal;
  let cssChanged = false;

  if (!cssOriginal.includes(marker)) {
    const tokenLines = NEW_TOKENS.map((t) => `  --${t.name}: ${t.value}; /* ${t.comment} */`).join("\n");
    const block = `\n${marker}\n/* Batch 1/4: color literals only. Reused-from-existing-token sites (see\n   TOKEN-AUDIT.md section 1.1) are NOT duplicated here — they reference\n   --status-task-in_progress / --status-task-done directly at the call site.\n\n   Allowlist (sites intentionally left as hardcoded / functional literals,\n   NOT converted to tokens — each also carries an inline\n   \`token-extraction: allowlisted\` comment at the site):\n   - pages/CompanyEnvironments.tsx — xterm.js terminal theme config; functional JS values, third-party.\n   - pages/CompanySettings.tsx — <input type="color"> value; functional form control, not a rendered value.\n   - components/issue-properties/IssueProperties.tsx (newLabelColor) — color-picker seed persisted into label-create payload.\n   - pages/CompanySkills.tsx (DISCOVERY_ACCENTS) — persisted/compared skill.color JS data, not just rendered.\n   - components/IssueColumns.tsx (accentColor fallback) — also feeds pickTextColorForPillBg() contrast math.\n   - components/CompanyPatternIcon.tsx — canvas fillStyle computed at runtime from numeric props, not a static literal.\n   - components/FileViewerSheet.tsx — half-migrated var(--paperclip-code-highlight-*, fallback) pattern; needs human decision, see TOKEN-AUDIT.md section 2.\n   - pages/InviteUxLab.tsx (brandColor prop, x2) — demo/showcase-only prop feeding CompanyPatternIcon's hexToHue() color math, not a rendered CSS value.\n*/\n:root {\n${tokenLines}\n}\n`;
    cssNext = cssOriginal + block;
    cssChanged = true;
  }

  if (cssChanged && !DRY_RUN) writeFileSync(cssPath, cssNext, "utf8");

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}codemod-extract-colors summary`);
  console.log(`  Sites rewritten:        ${totalSitesRewritten}`);
  console.log(`  Component/page files changed: ${filesChanged}`);
  console.log(`  Allowlist comments injected:  ${allowlistInjections}`);
  console.log(`  New tokens minted:      ${NEW_TOKENS.length}`);
  console.log(`  Existing tokens reused: ${Object.keys(REUSE).length} (${Object.values(REUSE).join(", ")})`);
  console.log(`  index.css token block:  ${cssChanged ? "added" : "already present (idempotent no-op)"}`);
  if (changedFiles.length) {
    console.log(`\n  Changed files:`);
    for (const f of changedFiles) console.log(`    - ui/src/${f}`);
  }
}

main();
