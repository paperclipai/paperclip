// Read-only research-paper evidence scanner.
//
// Scans local CPS self-practice reproduction artifacts and normalizes them into
// a single overview payload. This service NEVER writes, runs reproductions,
// touches brokers, or spends compute — it only reads files that other CPS loops
// already produced and degrades gracefully when paths are missing.
//
// The two verdict axes (paper reproduction vs. local validation) are preserved
// verbatim and never collapsed. A paper is only marked "refuted" when a faithful
// reproduction against extracted primary-source claim values was actually
// attempted.

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ResearchPaperArtifactFile,
  ResearchPaperArtifactKind,
  ResearchPaperBadge,
  ResearchPaperClaims,
  ResearchPaperEvidence,
  ResearchPaperLogEntry,
  ResearchPaperMetric,
  ResearchPaperMetricsBlock,
  ResearchPaperOverview,
  ResearchPaperRoot,
  ResearchPaperTone,
  ResearchToolbeltStatus,
} from "@paperclipai/shared";

export interface ResearchPapersServiceOptions {
  /** Directory holding `repro-repair-*` and `nautilus-spike-*` artifact groups. */
  selfPracticeDir?: string;
  /** JSONL ledger of paper candidates used purely for title/author enrichment. */
  candidatesFile?: string;
  /** Directory holding research toolbelt READINESS.json artifacts. */
  toolbeltDir?: string;
}

const DEFAULT_SELF_PRACTICE_DIR = "/root/cps/var/self_practice";
const DEFAULT_CANDIDATES_FILE = "/root/cli/micro-addon/research-loop/paper-candidates.jsonl";
const DEFAULT_TOOLBELT_DIR = "/root/cps/var/toolbelt";

const EXPERIMENT_DESIGN_MAX_CHARS = 1_600;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function humanizeKey(key: string): string {
  return key
    .replace(/\.([a-z])/gi, " · $1")
    .replace(/_/g, " ")
    .trim();
}

function humanizeVerdict(value: string): string {
  const lower = value.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function extractPaperId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(/PAPER-?(\d+)/i);
  return match ? `PAPER-${match[1]}` : null;
}

async function readJsonFile(filePath: string): Promise<Json | unknown | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function statFile(filePath: string): Promise<{ bytes: number; mtime: string } | null> {
  try {
    const stat = await fs.stat(filePath);
    return { bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function listDirents(dirPath: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * Minimal, dependency-free parser for the small `PAPER_CLAIMS.yaml` subset we
 * surface: top-level scalars, simple block lists, and `[]` empty arrays. Returns
 * an empty object on any failure so callers can degrade gracefully.
 */
function parsePaperClaimsYaml(text: string | null): Json {
  if (!text) return {};
  const out: Json = {};
  const lines = text.split(/\r?\n/);
  let listKey: string | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      const arr = (out[listKey] as unknown[]) ?? [];
      arr.push(stripScalar(listItem[1]));
      out[listKey] = arr;
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rest === "" ) {
      listKey = key;
      if (!(key in out)) out[key] = [];
      continue;
    }
    listKey = null;
    if (rest.trim() === "[]") {
      out[key] = [];
    } else {
      out[key] = stripScalar(rest);
    }
  }
  return out;
}

function stripScalar(value: string): unknown {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

const ARTIFACT_KIND_BY_NAME: Record<string, ResearchPaperArtifactKind> = {
  "VERDICT.json": "verdict",
  "REPRODUCTION_REPORT.json": "reproduction_report",
  "LOCAL_VALIDATION_REPORT.json": "local_validation",
  "BENCHMARKS.json": "benchmarks",
  "PAPER_CLAIMS.yaml": "paper_claims",
  "REPRODUCTION_PLAN.md": "reproduction_plan",
  "README.md": "readme",
  "LOOP_STATE.json": "loop_state",
};

function artifactKind(name: string): ResearchPaperArtifactKind {
  if (ARTIFACT_KIND_BY_NAME[name]) return ARTIFACT_KIND_BY_NAME[name];
  if (/TEST_REPORT\.json$/i.test(name)) return "test_report";
  if (/REPLAY/i.test(name)) return "replay";
  if (/\.(csv|parquet|json)$/i.test(name) && /inventory|returns|signals|sessions|metrics|nq_|portfolio/i.test(name)) {
    return "data";
  }
  return "other";
}

const METRIC_SHORT_LABEL: Record<string, string> = {
  sharpe: "Sharpe",
  cagr: "CAGR",
  total_return: "Total return",
  max_drawdown: "Max drawdown",
};

/** Flatten a flat object of scalars into display metrics, skipping strings. */
function summarizeFlatNumeric(obj: Json | null, limit = 18): ResearchPaperMetric[] {
  if (!obj) return [];
  const out: ResearchPaperMetric[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const n = num(value);
    if (n === null) continue;
    out.push({ key, label: humanizeKey(key), value: n });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Flatten a possibly-nested measured object: top-level scalars plus the headline
 * sub-metrics (sharpe/cagr/total_return/max_drawdown) of any nested objects such
 * as `*_oos_net`.
 */
function summarizeMeasured(obj: Json | null, limit = 22): ResearchPaperMetric[] {
  if (!obj) return [];
  const out: ResearchPaperMetric[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const n = num(value);
    if (n !== null) {
      out.push({ key, label: humanizeKey(key), value: n });
      continue;
    }
    const nested = asRecord(value);
    if (nested) {
      for (const [mk, mLabel] of Object.entries(METRIC_SHORT_LABEL)) {
        const mn = num(nested[mk]);
        if (mn !== null) {
          out.push({ key: `${key}.${mk}`, label: `${humanizeKey(key)} · ${mLabel}`, value: mn, group: key });
        }
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function classify(input: {
  paperReproductionVerdict: string | null;
  localValidationVerdict: string | null;
  claimValueStatus: string | null;
  comparability: string | null;
  paperRefuted: boolean | null;
  faithfulReproductionAttempted: boolean | null;
}): { headlineTone: ResearchPaperTone; badges: ResearchPaperBadge[] } {
  const badges: ResearchPaperBadge[] = [];
  const { paperReproductionVerdict: paperV, localValidationVerdict: localV, claimValueStatus: claim, comparability: comp } = input;

  // Paper reproduction axis.
  if (input.paperRefuted === true && input.faithfulReproductionAttempted === true) {
    badges.push({
      label: "Paper refuted",
      tone: "refuted",
      axis: "paper",
      detail: "A faithful reproduction against extracted primary-source claim values was attempted and did not hold.",
    });
  } else if (paperV) {
    if (/REPRODUCED/i.test(paperV)) {
      badges.push({ label: "Paper reproduced", tone: "reproduced", axis: "paper" });
    } else if (/DATA_BLOCKED/i.test(paperV)) {
      badges.push({ label: "Data blocked", tone: "data_blocked", axis: "paper", detail: "Paper-faithful data was not available locally." });
    } else if (/MISSING_PRIMARY_SOURCE/i.test(paperV)) {
      badges.push({
        label: "Claim values missing",
        tone: "claims_missing",
        axis: "paper",
        detail: "Primary-source numeric claim values were not preserved, so no faithful reproduction was scored. This is not a refutation.",
      });
    } else if (/NOT_ASSESSED/i.test(paperV)) {
      badges.push({ label: "Paper not assessed", tone: "not_assessed", axis: "paper" });
    } else {
      badges.push({ label: humanizeVerdict(paperV), tone: "neutral", axis: "paper" });
    }
  }

  // Local validation axis.
  if (localV) {
    if (/KILL/i.test(localV)) {
      badges.push({
        label: "Local kill",
        tone: "local_kill",
        axis: "local",
        detail: "A local adaptation/proxy failed its validation gates. This is not evidence against the original paper.",
      });
    } else if (/NOT_COMPARABLE/i.test(localV)) {
      badges.push({ label: "Local non-comparable", tone: "not_comparable", axis: "local", detail: "Local proxy used a different universe/sample than the paper." });
    } else if (/PASS|PROMOTE|REPRODUCED/i.test(localV)) {
      badges.push({ label: humanizeVerdict(localV), tone: "local_pass", axis: "local" });
    } else {
      badges.push({ label: humanizeVerdict(localV), tone: "neutral", axis: "local" });
    }
  } else if (comp && /NOT_COMPARABLE/i.test(comp)) {
    badges.push({ label: "Non-comparable", tone: "not_comparable", axis: "local", detail: "Local proxy used a different universe/sample than the paper." });
  }

  // Claim-status axis (only when it adds information).
  if (claim && /EXTRACTED/i.test(claim)) {
    badges.push({ label: "Claims extracted", tone: "claims_extracted", axis: "claims", detail: humanizeVerdict(claim) });
  }

  const headline = badges.find((b) => b.axis === "paper") ?? badges[0];
  return { headlineTone: headline?.tone ?? "neutral", badges };
}

function logEntry(ts: string | null, label: string, source: string, detail?: string): ResearchPaperLogEntry {
  return detail ? { ts, label, source, detail } : { ts, label, source };
}

function sortLog(entries: ResearchPaperLogEntry[]): ResearchPaperLogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.ts && b.ts) return a.ts.localeCompare(b.ts);
    if (a.ts) return -1;
    if (b.ts) return 1;
    return 0;
  });
}

const LOG_FILE_LABELS: Array<[string, string]> = [
  ["PAPER_CLAIMS.yaml", "Paper claims captured / classified"],
  ["REPRODUCTION_PLAN.md", "Reproduction plan drafted"],
  ["inventory.json", "Local data inventory captured"],
  ["cps_data_inventory_fresh.json", "Local data inventory captured"],
  ["LOCAL_VALIDATION_REPORT.json", "Local validation run recorded"],
  ["BENCHMARKS.json", "Benchmarks computed"],
  ["REPRODUCTION_REPORT.json", "Reproduction report written"],
  ["VERDICT.json", "Verdict finalized"],
  ["README.md", "Summary written"],
];

interface LoopReverseEntry {
  label: string;
  terminalVerdict: Json | null;
}

function buildLoopReverse(loop: unknown): Map<string, LoopReverseEntry> {
  const reverse = new Map<string, LoopReverseEntry>();
  const loopRec = asRecord(loop);
  if (!loopRec) return reverse;
  const artifactPaths = asRecord(loopRec.artifact_paths);
  const terminalVerdicts = asRecord(loopRec.terminal_verdicts);
  if (!artifactPaths) return reverse;
  for (const [label, dirPath] of Object.entries(artifactPaths)) {
    if (typeof dirPath !== "string") continue;
    const base = path.basename(dirPath);
    const tv = terminalVerdicts ? asRecord(terminalVerdicts[label]) : null;
    reverse.set(base, { label, terminalVerdict: tv });
  }
  return reverse;
}

async function loadCandidates(candidatesFile: string): Promise<Map<string, Json>> {
  const map = new Map<string, Json>();
  const text = await readTextFile(candidatesFile);
  if (!text) return map;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = asRecord(JSON.parse(line));
      const id = rec ? asString(rec.id) : null;
      if (rec && id) map.set(id, rec);
    } catch {
      // skip malformed line
    }
  }
  return map;
}

async function buildArtifactList(dir: string, names: string[]): Promise<ResearchPaperArtifactFile[]> {
  const files: ResearchPaperArtifactFile[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await statFile(full);
    files.push({
      name,
      path: full,
      kind: artifactKind(name),
      bytes: stat?.bytes ?? null,
      modifiedAt: stat?.mtime ?? null,
    });
  }
  // Important kinds first, then by name for stability.
  const kindRank: Record<string, number> = {
    verdict: 0,
    reproduction_report: 1,
    local_validation: 2,
    benchmarks: 3,
    paper_claims: 4,
    reproduction_plan: 5,
    readme: 6,
    test_report: 7,
    replay: 8,
    loop_state: 9,
    data: 10,
    other: 11,
  };
  return files.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind]) || a.name.localeCompare(b.name));
}

async function buildPaperFromDir(
  dir: string,
  ctx: { group: string; loopReverse: Map<string, LoopReverseEntry>; candidates: Map<string, Json> },
): Promise<ResearchPaperEvidence | null> {
  const dirents = await listDirents(dir);
  const names = dirents.filter((d) => !d.isDir).map((d) => d.name);
  const nameSet = new Set(names);
  const hasCore = nameSet.has("VERDICT.json") || nameSet.has("REPRODUCTION_REPORT.json") || nameSet.has("LOCAL_VALIDATION_REPORT.json");
  if (!hasCore) return null;

  const base = path.basename(dir);
  const verdict = asRecord(await readJsonFile(path.join(dir, "VERDICT.json"))) ?? {};
  const report = asRecord(await readJsonFile(path.join(dir, "REPRODUCTION_REPORT.json"))) ?? {};
  const localVal = asRecord(await readJsonFile(path.join(dir, "LOCAL_VALIDATION_REPORT.json")));
  const benchmarks = asRecord(await readJsonFile(path.join(dir, "BENCHMARKS.json")));
  const claimsYaml = parsePaperClaimsYaml(await readTextFile(path.join(dir, "PAPER_CLAIMS.yaml")));
  const readme = await readTextFile(path.join(dir, "README.md"));
  const plan = await readTextFile(path.join(dir, "REPRODUCTION_PLAN.md"));

  const loopEntry = ctx.loopReverse.get(base) ?? null;
  const terminalVerdict = loopEntry?.terminalVerdict ?? null;

  const paperId =
    extractPaperId(asString(report.paper_id)) ??
    extractPaperId(asString(report.matched_candidate_id)) ??
    extractPaperId(asString(verdict.matched_candidate_id)) ??
    extractPaperId(asString(verdict.target)) ??
    extractPaperId(base);
  const candidate = paperId ? ctx.candidates.get(paperId) ?? null : null;

  const category = base.startsWith("micro-paper-") || base.startsWith("micro_paper_") ? "micro_addon" : "paper_family";
  const family =
    asString(report.paper_family) ??
    asString(claimsYaml.paper_family) ??
    null;
  const title =
    asString(report.title) ??
    (candidate ? asString(candidate.title) : null) ??
    loopEntry?.label ??
    (family ? humanizeKey(family) : null) ??
    humanizeKey(base);

  const authors = asStringArray(report.authors).length
    ? asStringArray(report.authors)
    : candidate
      ? asStringArray(candidate.authors)
      : [];
  const sourceUrl =
    asString(report.source_url) ??
    (candidate ? asString(candidate.url) ?? asString(candidate.pdf_url) : null) ??
    null;

  const paperReproductionVerdict =
    asString(verdict.paper_reproduction_verdict) ??
    asString(report.paper_reproduction_verdict) ??
    (terminalVerdict ? asString(terminalVerdict.paper_reproduction_verdict) : null);
  const localValidationVerdict =
    asString(verdict.local_validation_verdict) ??
    (terminalVerdict ? asString(terminalVerdict.local_validation_verdict) : null) ??
    (localVal ? asString(localVal.local_validation_verdict) : null);
  const claimValueStatus =
    asString(verdict.claim_value_status) ??
    asString(report.claim_value_status) ??
    asString(report.paper_reproduction_claim_value_status) ??
    (terminalVerdict ? asString(terminalVerdict.paper_reproduction_claim_value_status) : null) ??
    asString(claimsYaml.claim_value_status);
  const comparability =
    asString(verdict.comparability) ??
    (localVal ? asString(localVal.comparability) : null) ??
    (terminalVerdict ? asString(terminalVerdict.comparability) : null);

  const paperRefuted =
    asBool(verdict.paper_refuted) ??
    asBool(report.paper_refuted) ??
    (terminalVerdict ? asBool(terminalVerdict.paper_refuted) : null);
  const notAPaperRefutation = asBool(verdict.not_a_paper_refutation) ?? asBool(report.not_a_paper_refutation);
  const faithfulReproductionAttempted = asBool(report.faithful_reproduction_attempted);
  const promotionAllowed =
    asBool(verdict.promotion_allowed) ??
    asBool((verdict.promotion as Json | undefined)?.allowed) ??
    asBool(report.promotion_allowed);

  const { headlineTone, badges } = classify({
    paperReproductionVerdict,
    localValidationVerdict,
    claimValueStatus,
    comparability,
    paperRefuted,
    faithfulReproductionAttempted,
  });

  const claims: ResearchPaperClaims = {
    primarySources: asStringArray(claimsYaml.primary_sources),
    qualitativeClaims: asStringArray(report.qualitative_claims_preserved),
    numericClaimValues: asRecord(report.numeric_claim_values) ?? undefined,
    numericClaimsExtracted:
      asBool(claimsYaml.paper_numeric_claims_extracted) ??
      asBool(report.paper_numeric_claims_extracted),
    notes: asStringArray(claimsYaml.notes),
  };
  if (claims.numericClaimValues && Object.keys(claims.numericClaimValues).length === 0) {
    claims.numericClaimValues = undefined;
  }

  const measuredRaw =
    asRecord(verdict.measured_numbers) ??
    asRecord(verdict.measured_local_proxy_numbers) ??
    terminalVerdict ??
    null;
  const measuredSummary = terminalVerdict
    ? summarizeFlatNumeric(terminalVerdict)
    : summarizeMeasured(measuredRaw);
  const measured: ResearchPaperMetricsBlock = { summary: measuredSummary, raw: measuredRaw };

  const benchmark: ResearchPaperMetricsBlock = {
    summary: summarizeMeasured(benchmarks),
    raw: benchmarks,
  };

  const failingGates =
    (asRecord(verdict.failing_gates) as Record<string, string[]> | null) ??
    (Array.isArray(verdict.failing_gates) ? (verdict.failing_gates as string[]) : null);

  const safetyFlags = asRecord(verdict.safety) as Record<string, boolean> | null;

  const blockers = (() => {
    const fromReport = asStringArray(report.faithful_reproduction_blockers);
    if (fromReport.length) return fromReport;
    const single = asString(verdict.blocker);
    return single ? [single] : [];
  })();

  const experimentDesign = (readme ?? plan)?.slice(0, EXPERIMENT_DESIGN_MAX_CHARS) ?? null;

  // Chronological log from artifact mtimes + a couple of content-derived events.
  const logEntries: ResearchPaperLogEntry[] = [];
  const seenLabels = new Set<string>();
  for (const [fileName, label] of LOG_FILE_LABELS) {
    if (!nameSet.has(fileName) || seenLabels.has(label)) continue;
    const stat = await statFile(path.join(dir, fileName));
    let detail: string | undefined;
    if (fileName === "VERDICT.json") {
      detail = `Paper: ${paperReproductionVerdict ?? "n/a"} · Local: ${localValidationVerdict ?? "n/a"}`;
    } else if (fileName === "LOCAL_VALIDATION_REPORT.json" && localVal) {
      const readiness = asRecord(localVal.data_readiness);
      const first = readiness ? asString(readiness.first_date) : null;
      const last = readiness ? asString(readiness.last_date) : null;
      const rows = readiness ? num(readiness.rows) : null;
      if (first && last) detail = `Data window ${first} → ${last}${rows ? ` (${rows} rows)` : ""}`;
    }
    logEntries.push(logEntry(stat?.mtime ?? null, label, fileName, detail));
    seenLabels.add(label);
  }

  const artifacts = await buildArtifactList(dir, names);

  return {
    id: `${ctx.group}__${base}`,
    slug: base,
    title: title ?? base,
    family,
    category,
    group: ctx.group,
    paperId,
    authors,
    sourceUrl,
    paperReproductionVerdict,
    localValidationVerdict,
    claimValueStatus,
    comparability,
    paperRefuted,
    notAPaperRefutation,
    faithfulReproductionAttempted,
    promotionAllowed,
    headlineTone,
    badges,
    claims,
    measured,
    benchmark,
    failingGates,
    safetyFlags,
    blockers,
    experimentDesign,
    log: sortLog(logEntries),
    artifacts,
    artifactDir: dir,
  };
}

async function buildSpikeFromDir(dir: string, ctx: { group: string }): Promise<ResearchPaperEvidence | null> {
  const dirents = await listDirents(dir);
  const names = dirents.filter((d) => !d.isDir).map((d) => d.name);
  const reportName = names.find((n) => /TEST_REPORT\.json$/i.test(n));
  if (!reportName) return null;

  const report = asRecord(await readJsonFile(path.join(dir, reportName))) ?? {};
  const mdName = names.find((n) => /\.md$/i.test(n)) ?? null;
  const md = mdName ? await readTextFile(path.join(dir, mdName)) : null;
  const mdTitle = md?.match(/^#\s+(.+)$/m)?.[1] ?? null;

  const readiness = asRecord(report.readiness) ?? {};
  const replay = asRecord(report.replay) ?? {};
  const replayMetrics = asRecord(replay.metrics);
  const status = asString(readiness.status);
  const safetyFlags =
    (asRecord(readiness.safety) as Record<string, boolean> | null) ??
    (asRecord(report.safety) as Record<string, boolean> | null);
  const blockers = asStringArray(readiness.blockers);

  const tone: ResearchPaperTone = status && /PASS/i.test(status) ? "local_pass" : "spike";
  const badges: ResearchPaperBadge[] = [
    { label: "Execution spike", tone: "spike", axis: "status" },
  ];
  if (status) {
    badges.push({ label: humanizeVerdict(status), tone, axis: "status", detail: "Read-only replay readiness; no orders, no live services." });
  }

  const logEntries: ResearchPaperLogEntry[] = [];
  const generated = asString(report.generated_utc);
  if (generated) logEntries.push(logEntry(generated, "Replay spike generated", reportName));
  const reportStat = await statFile(path.join(dir, reportName));
  logEntries.push(logEntry(reportStat?.mtime ?? null, "Readiness report written", reportName, status ? `Status ${status}` : undefined));
  if (mdName) {
    const mdStat = await statFile(path.join(dir, mdName));
    logEntries.push(logEntry(mdStat?.mtime ?? null, "Spike summary written", mdName));
  }

  return {
    id: `${ctx.group}__spike`,
    slug: ctx.group,
    title: mdTitle ?? "Nautilus replay spike",
    family: null,
    category: "execution_spike",
    group: ctx.group,
    paperId: null,
    authors: [],
    sourceUrl: null,
    paperReproductionVerdict: null,
    localValidationVerdict: null,
    claimValueStatus: null,
    comparability: null,
    paperRefuted: null,
    notAPaperRefutation: null,
    faithfulReproductionAttempted: null,
    promotionAllowed: asBool(readiness.promotion_allowed),
    headlineTone: tone,
    badges,
    claims: { numericClaimsExtracted: null },
    measured: { summary: summarizeMeasured(replayMetrics), raw: replayMetrics },
    benchmark: { summary: [], raw: null },
    failingGates: null,
    safetyFlags,
    blockers,
    experimentDesign: md?.slice(0, EXPERIMENT_DESIGN_MAX_CHARS) ?? null,
    log: sortLog(logEntries),
    artifacts: await buildArtifactList(dir, names),
    artifactDir: dir,
  };
}

function safeBoolRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

async function loadToolbelts(toolbeltDir: string): Promise<ResearchToolbeltStatus[]> {
  const entries = await listDirents(toolbeltDir);
  const toolbelts: ResearchToolbeltStatus[] = [];
  for (const entry of entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(toolbeltDir, entry.name);
    const readiness = asRecord(await readJsonFile(path.join(dir, "READINESS.json")));
    if (!readiness) continue;
    const summary = safeBoolRecord(readiness.summary);
    const safeActions = safeBoolRecord(readiness.safe_actions);
    const failedImports = Array.isArray(readiness.failed_imports)
      ? readiness.failed_imports.filter((v): v is string => typeof v === "string")
      : [];
    const ready = Boolean(
      summary.ready_for_paper_reproduction
        ?? summary.ready_for_systematic_futures_reference
        ?? summary.ready_for_legacy_backtest
        ?? (failedImports.length === 0),
    );
    toolbelts.push({
      name: asString(readiness.name) ?? entry.name,
      path: asString(readiness.env_path) ?? dir,
      generatedAt: asString(readiness.generated_utc),
      ready,
      toolCount: num(summary.tool_count) ?? 0,
      importOk: num(summary.import_ok) ?? 0,
      failed: num(summary.failed) ?? failedImports.length,
      failedImports,
      safeActions: {
        brokerActions: Boolean(safeActions.broker_actions),
        paidData: Boolean(safeActions.paid_data),
        paidCompute: Boolean(safeActions.paid_compute),
        secretChanges: Boolean(safeActions.secret_changes),
      },
      notes: asStringArray(readiness.notes),
    });
  }
  return toolbelts;
}

const CATEGORY_RANK: Record<string, number> = {
  paper_family: 0,
  micro_addon: 1,
  execution_spike: 2,
};

export function researchPapersService(options: ResearchPapersServiceOptions = {}) {
  const selfPracticeDir =
    options.selfPracticeDir ?? process.env.PAPERCLIP_RESEARCH_PAPER_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
  const candidatesFile =
    options.candidatesFile ?? process.env.PAPERCLIP_RESEARCH_PAPER_CANDIDATES_FILE ?? DEFAULT_CANDIDATES_FILE;
  const toolbeltDir = options.toolbeltDir ?? process.env.PAPERCLIP_RESEARCH_TOOLBELT_DIR ?? DEFAULT_TOOLBELT_DIR;

  return {
    async overview(companyId: string): Promise<ResearchPaperOverview> {
      const candidates = await loadCandidates(candidatesFile);
      const topLevel = await listDirents(selfPracticeDir);
      const repairGroups = topLevel.filter((d) => d.isDir && d.name.startsWith("repro-repair-")).map((d) => d.name).sort();
      const spikeGroups = topLevel.filter((d) => d.isDir && d.name.startsWith("nautilus-spike-")).map((d) => d.name).sort();

      const papers: ResearchPaperEvidence[] = [];
      const roots: ResearchPaperRoot[] = [];

      for (const group of repairGroups) {
        const groupDir = path.join(selfPracticeDir, group);
        const loop = await readJsonFile(path.join(groupDir, "LOOP_STATE.json"));
        const loopReverse = buildLoopReverse(loop);
        const subdirs = (await listDirents(groupDir)).filter((d) => d.isDir && !d.name.startsWith("__"));
        let count = 0;
        for (const sub of subdirs) {
          const paper = await buildPaperFromDir(path.join(groupDir, sub.name), { group, loopReverse, candidates });
          if (paper) {
            papers.push(paper);
            count += 1;
          }
        }
        roots.push({ path: groupDir, label: `Reproduction repair · ${group.replace("repro-repair-", "")}`, present: true, count });
      }

      for (const group of spikeGroups) {
        const groupDir = path.join(selfPracticeDir, group);
        const spike = await buildSpikeFromDir(groupDir, { group });
        if (spike) papers.push(spike);
        roots.push({ path: groupDir, label: `Execution spike · ${group.replace("nautilus-spike-", "")}`, present: true, count: spike ? 1 : 0 });
      }

      const candidatesPresent = candidates.size > 0 || (await statFile(candidatesFile)) !== null;
      roots.push({ path: candidatesFile, label: "Paper candidates ledger (enrichment)", present: candidatesPresent, count: candidates.size });

      const toolbelts = await loadToolbelts(toolbeltDir);
      const toolbeltPresent = (await statFile(toolbeltDir)) !== null || toolbelts.length > 0;
      roots.push({ path: toolbeltDir, label: "Research toolbelt readiness", present: toolbeltPresent, count: toolbelts.length });

      if (repairGroups.length === 0 && spikeGroups.length === 0) {
        // Surface the scanned self-practice root so the absence is visible.
        const present = (await statFile(selfPracticeDir)) !== null || topLevel.length > 0;
        roots.unshift({ path: selfPracticeDir, label: "CPS self-practice root", present, count: 0 });
      }

      papers.sort((a, b) => {
        const rank = (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9);
        if (rank !== 0) return rank;
        return a.title.localeCompare(b.title);
      });

      const byCategory: Record<string, number> = {};
      const byTone: Record<string, number> = {};
      for (const paper of papers) {
        byCategory[paper.category] = (byCategory[paper.category] ?? 0) + 1;
        byTone[paper.headlineTone] = (byTone[paper.headlineTone] ?? 0) + 1;
      }

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        roots,
        counts: { total: papers.length, byCategory, byTone },
        papers,
        toolbelts,
        safety: {
          readOnly: true,
          brokerActions: false,
          paidComputeActions: false,
          note: "Read-only evidence view. It scans local CPS reproduction artifacts and never runs reproductions, backtests, brokers, paid compute, or promotions.",
        },
      };
    },
  };
}

export type ResearchPapersService = ReturnType<typeof researchPapersService>;
