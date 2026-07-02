// Read-only CPS experiment index scanner.
//
// Exposes the local experiment-tracker JSON produced under CPS self_practice.
// This service never runs experiments, never mutates CPS artifacts, never calls
// brokers/paid APIs, and never publishes signals.

import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateCpsJudgmentFeedbackInput,
  CreateCpsRunRequestInput,
  CpsExperimentEntry,
  CpsExperimentJudgment,
  CpsExperimentOverview,
  CpsJudgmentFeedback,
  CpsOperatorAction,
  CpsOperatorLabelSummary,
  CpsPaperProgress,
  CpsRunRequest,
  CpsRunRequestAction,
} from "@paperclipai/shared";

export interface CpsExperimentsServiceOptions {
  indexFile?: string;
  selfPracticeDir?: string;
  evalsDir?: string;
  staleAfterMs?: number;
  recentLimit?: number;
  runRequestsDir?: string;
  evalMinLabels?: number;
}

const DEFAULT_SELF_PRACTICE_DIR = "/root/cps/var/self_practice";
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 40;
// Mirrors the exporter default (`scripts/export-cps-judgment-dataset.py --min-eval-labels`).
const DEFAULT_EVAL_MIN_LABELS = 100;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asStringNumberRecord(value: unknown): Record<string, number> {
  const rec = asRecord(value);
  if (!rec) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const RUN_REQUEST_ACTIONS: ReadonlySet<CpsRunRequestAction> = new Set([
  "rerun_with_variant",
  "investigate_near_miss",
  "refresh_index",
  "custom_bounded_research",
  "generate_judgment",
  "revise_judgment_from_operator_label",
  "delegate_quant_review",
  "delegate_data_feasibility",
  "run_next_safe_action",
  "build_operator_dossier",
  "archive_failure_with_learning",
]);

const JUDGMENT_FEEDBACK_LABELS = new Set([
  "agree",
  "disagree",
  "too_optimistic",
  "too_conservative",
  "wrong_blocker",
  "proceed_autonomously",
  "archive",
  "requires_approval",
]);

// JUDGMENT.json blocker route_to_role enum. The schema value is `quant_review`
// (not the roles-table `quant_research`) — see the judgment-loop plan doc.
const JUDGMENT_ROUTE_ROLES = new Set([
  "data_engineering",
  "quant_review",
  "platform_engineering",
  "board",
  "external_vendor",
]);

function assertRunRequestInput(input: CreateCpsRunRequestInput) {
  if (!RUN_REQUEST_ACTIONS.has(input.action)) {
    throw new Error(`Unsupported CPS run request action: ${String(input.action)}`);
  }
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length < 8) throw new Error("CPS run request prompt is required");
  if (prompt.length > 4000) throw new Error("CPS run request prompt is too long");
  const maxRuntime = input.maxRuntimeMinutes ?? 60;
  if (!Number.isFinite(maxRuntime) || maxRuntime < 1 || maxRuntime > 360) {
    throw new Error("maxRuntimeMinutes must be between 1 and 360");
  }
}

function assertJudgmentFeedbackInput(input: CreateCpsJudgmentFeedbackInput) {
  const experimentId = input.experimentId?.trim();
  if (!experimentId) throw new Error("experimentId is required");
  if (experimentId.length > 160) throw new Error("experimentId is too long");
  const label = input.label?.trim();
  if (!label || !JUDGMENT_FEEDBACK_LABELS.has(label)) throw new Error("Unsupported judgment feedback label");
  if (input.correctedVerdict && input.correctedVerdict.length > 160) throw new Error("correctedVerdict is too long");
  const routeToRole = input.routeToRole?.trim();
  if (routeToRole && !JUDGMENT_ROUTE_ROLES.has(routeToRole)) throw new Error("Unsupported judgment feedback routeToRole");
  if (input.comment && input.comment.length > 2000) throw new Error("comment is too long");
}

function increment(counter: Record<string, number>, key: string | null | undefined) {
  if (!key) return;
  counter[key] = (counter[key] ?? 0) + 1;
}

function nestedStatus(value: unknown): string | null {
  const rec = asRecord(value);
  return asString(rec?.status);
}

function safeSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "request";
}

function resolveRunRequestsDir(options: CpsExperimentsServiceOptions) {
  return options.runRequestsDir ?? process.env.PAPERCLIP_CPS_RUN_REQUESTS_DIR ?? path.join(
    options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR,
    "paperclip-run-requests",
  );
}

function mapEntry(raw: unknown): CpsExperimentEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const updatedUtc = asString(rec.updated_utc) ?? asString(rec.updatedUtc);
  const kind = asString(rec.kind);
  const status = asString(rec.status);
  if (!id || !updatedUtc || !kind || !status) return null;
  const summary = asRecord(rec.summary) ?? {};
  return {
    id,
    runId: asString(rec.run_id) ?? asString(rec.runId) ?? id,
    path: asString(rec.path),
    absolutePath: asString(rec.absolute_path) ?? asString(rec.absolutePath),
    updatedUtc,
    kind,
    status,
    decision: asString(rec.decision),
    primaryJson: asString(rec.primary_json) ?? asString(rec.primaryJson),
    absolutePrimaryJson: asString(rec.absolute_primary_json) ?? asString(rec.absolutePrimaryJson),
    files: asStringArray(rec.files),
    summary,
  };
}

function resolveEntryDir(entry: Pick<CpsExperimentEntry, "absolutePath" | "path">, selfPracticeDir: string): string | null {
  const raw = entry.absolutePath ?? entry.path;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(selfPracticeDir, raw);
}

async function readJudgment(entry: CpsExperimentEntry, selfPracticeDir: string): Promise<CpsExperimentEntry> {
  const entryDir = resolveEntryDir(entry, selfPracticeDir);
  if (!entryDir) return { ...entry, judgment: null, judgmentPath: null };
  const judgmentPath = path.join(entryDir, "JUDGMENT.json");
  try {
    const text = await fs.readFile(judgmentPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const judgment = asRecord(parsed) as CpsExperimentJudgment | null;
    return { ...entry, judgment, judgmentPath: judgment ? path.normalize(judgmentPath) : null };
  } catch {
    return { ...entry, judgment: null, judgmentPath: null };
  }
}

// Reads the cps.paper_progress.v1 sidecar written by pods/backfill tooling.
async function readProgress(entry: CpsExperimentEntry, selfPracticeDir: string): Promise<CpsExperimentEntry> {
  const entryDir = resolveEntryDir(entry, selfPracticeDir);
  if (!entryDir) return { ...entry, progress: null, progressPath: null };
  const progressPath = path.join(entryDir, "PROGRESS.json");
  try {
    const text = await fs.readFile(progressPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const progress = asRecord(parsed) as CpsPaperProgress | null;
    return { ...entry, progress, progressPath: progress ? path.normalize(progressPath) : null };
  } catch {
    return { ...entry, progress: null, progressPath: null };
  }
}

// Collects stuck, human-required stage blockers across all entries into the
// board's plain-language "Operator actions" list.
function collectOperatorActions(entries: CpsExperimentEntry[]): CpsOperatorAction[] {
  const actions: CpsOperatorAction[] = [];
  for (const entry of entries) {
    const stages = Array.isArray(entry.progress?.stages) ? entry.progress.stages : [];
    for (const stage of stages) {
      const rec = asRecord(stage);
      if (!rec) continue;
      if (asString(rec.status) !== "stuck") continue;
      const blocker = asRecord(rec.blocker);
      if (!blocker) continue;
      const humanRequired = blocker.human_required === true || blocker.humanRequired === true;
      if (!humanRequired) continue;
      const stageName = asString(rec.stage) ?? "unknown";
      actions.push({
        experimentId: entry.id,
        stage: stageName,
        kind: asString(blocker.kind),
        simpleAsk: asString(blocker.simple_ask) ?? asString(blocker.simpleAsk) ?? `Experiment ${entry.id} is stuck at stage "${stageName}" and needs a human decision.`,
        link: asString(blocker.link),
      });
    }
  }
  return actions;
}

async function readIndex(indexFile: string): Promise<Json | null> {
  try {
    const text = await fs.readFile(indexFile, "utf8");
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

async function fileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

interface OperatorLabelsIndex {
  byExperiment: Map<string, CpsOperatorLabelSummary>;
  total: number;
  byLabel: Record<string, number>;
}

// Reads the append-only LABELS.jsonl written by createJudgmentFeedback. The
// file is append-only, so the last line per experiment is the latest label.
async function readOperatorLabels(labelsFile: string): Promise<OperatorLabelsIndex> {
  const byExperiment = new Map<string, CpsOperatorLabelSummary>();
  const byLabel: Record<string, number> = {};
  let total = 0;
  let text: string;
  try {
    text = await fs.readFile(labelsFile, "utf8");
  } catch {
    return { byExperiment, total, byLabel };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    const experimentId = asString(rec.experimentId) ?? asString(rec.experiment_id);
    const label = asString(rec.label);
    if (!experimentId || !label) continue;
    total += 1;
    increment(byLabel, label);
    const prev = byExperiment.get(experimentId);
    byExperiment.set(experimentId, {
      count: (prev?.count ?? 0) + 1,
      latestLabel: label,
      latestCorrectedVerdict: asString(rec.correctedVerdict) ?? asString(rec.corrected_verdict),
      latestRouteToRole: asString(rec.routeToRole) ?? asString(rec.route_to_role),
      latestComment: asString(rec.comment),
      latestAt: asString(rec.createdAt) ?? asString(rec.created_at),
    });
  }
  return { byExperiment, total, byLabel };
}

async function jsonlStatus(filePath: string): Promise<{ rows: number | null; updatedUtc: string | null }> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    const rows = text.split("\n").filter((line) => line.trim().length > 0).length;
    return { rows, updatedUtc: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return { rows: null, updatedUtc: null };
  }
}

function resolveEvalsDir(options: CpsExperimentsServiceOptions, selfPracticeDir: string): string {
  return options.evalsDir ?? process.env.PAPERCLIP_CPS_EVALS_DIR ?? path.join(selfPracticeDir, "..", "evals");
}

async function resolveIndexFile(options: Pick<CpsExperimentsServiceOptions, "indexFile" | "selfPracticeDir">): Promise<string> {
  if (options.indexFile) return options.indexFile;
  if (process.env.PAPERCLIP_CPS_EXPERIMENTS_INDEX) return process.env.PAPERCLIP_CPS_EXPERIMENTS_INDEX;
  const base = options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("experiment-tracker-"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    if (latest) return path.join(base, latest, "EXPERIMENTS_INDEX.json");
  } catch {
    // Fall through to the stable non-date fallback below.
  }
  return path.join(base, "EXPERIMENTS_INDEX.json");
}

export function cpsExperimentsService(options: CpsExperimentsServiceOptions = {}) {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  return {
    async createRunRequest(companyId: string, input: CreateCpsRunRequestInput): Promise<CpsRunRequest> {
      assertRunRequestInput(input);
      const requestedAt = new Date().toISOString();
      const runRequestsDir = resolveRunRequestsDir(options);
      await fs.mkdir(runRequestsDir, { recursive: true });
      const experimentId = input.experimentId?.trim() || null;
      const id = `${requestedAt.replace(/[-:.]/g, "").slice(0, 15)}-${safeSlug(input.action)}${experimentId ? `-${safeSlug(experimentId)}` : ""}`;
      const requestPath = path.join(runRequestsDir, `${id}.json`);
      const queuePath = path.join(runRequestsDir, "QUEUE.jsonl");
      const request: CpsRunRequest = {
        schema: "cps.paperclip_run_request.v1",
        id,
        companyId,
        action: input.action,
        experimentId,
        prompt: input.prompt.trim(),
        requestedAt,
        requestedBy: "board",
        status: "queued",
        maxRuntimeMinutes: Math.trunc(input.maxRuntimeMinutes ?? 60),
        safety: {
          brokerActions: false,
          signalPublishing: false,
          allowPaidData: input.allowPaidData === true,
          allowPaidCompute: input.allowPaidCompute === true,
          note: "Paperclip is authorized to queue bounded CPS research runs here; executors must still enforce no broker actions and no public signal publishing.",
        },
        path: path.normalize(requestPath),
        queuePath: path.normalize(queuePath),
      };
      const line = `${JSON.stringify(request)}\n`;
      await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
      await fs.appendFile(queuePath, line);
      return request;
    },

    async createJudgmentFeedback(companyId: string, input: CreateCpsJudgmentFeedbackInput): Promise<CpsJudgmentFeedback> {
      assertJudgmentFeedbackInput(input);
      const createdAt = new Date().toISOString();
      const selfPracticeDir = options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
      const labelsDir = path.join(selfPracticeDir, "paperclip-judgment-labels");
      await fs.mkdir(labelsDir, { recursive: true });
      const experimentId = input.experimentId.trim();
      const id = `${createdAt.replace(/[-:.]/g, "").slice(0, 15)}-${safeSlug(input.label)}-${safeSlug(experimentId)}`;
      const feedbackPath = path.join(labelsDir, `${id}.json`);
      const queuePath = path.join(labelsDir, "LABELS.jsonl");
      const judgmentPath = path.join(selfPracticeDir, experimentId, "JUDGMENT.json");
      const judgmentExists = await fileMtimeMs(judgmentPath);
      const feedback: CpsJudgmentFeedback = {
        schema: "cps.judgment_feedback.v1",
        id,
        companyId,
        experimentId,
        label: input.label.trim(),
        correctedVerdict: input.correctedVerdict?.trim() || null,
        routeToRole: input.routeToRole?.trim() || null,
        comment: input.comment?.trim() || null,
        createdAt,
        createdBy: "board",
        judgmentPath: judgmentExists !== null ? path.normalize(judgmentPath) : null,
        path: path.normalize(feedbackPath),
        queuePath: path.normalize(queuePath),
      };
      const line = `${JSON.stringify(feedback)}\n`;
      await fs.writeFile(feedbackPath, `${JSON.stringify(feedback, null, 2)}\n`, { flag: "wx" });
      await fs.appendFile(queuePath, line);
      return feedback;
    },

    async overview(companyId: string): Promise<CpsExperimentOverview> {
      const indexFile = await resolveIndexFile(options);
      const raw = await readIndex(indexFile);
      const now = Date.now();
      const generatedAt = new Date(now).toISOString();
      const indexMtimeMs = await fileMtimeMs(indexFile);
      const sourceGeneratedMs = parseDateMs(asString(raw?.generated_utc) ?? asString(raw?.generatedAt));
      const freshestMs = sourceGeneratedMs ?? indexMtimeMs;
      const ageSeconds = freshestMs === null ? null : Math.max(0, Math.round((now - freshestMs) / 1000));
      const selfPracticeDir = options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
      const labelsFile = path.join(selfPracticeDir, "paperclip-judgment-labels", "LABELS.jsonl");
      const operatorLabels = await readOperatorLabels(labelsFile);
      const entries = (await Promise.all(
        (Array.isArray(raw?.entries) ? raw.entries.map(mapEntry).filter((entry): entry is CpsExperimentEntry => entry !== null) : [])
          .map((entry) => readJudgment(entry, selfPracticeDir).then((withJudgment) => readProgress(withJudgment, selfPracticeDir))),
      )).map((entry) => ({ ...entry, operatorLabels: operatorLabels.byExperiment.get(entry.id) ?? null }));
      entries.sort((a, b) => b.updatedUtc.localeCompare(a.updatedUtc));
      const operatorActions = collectOperatorActions(entries);

      const evalsDir = resolveEvalsDir(options, selfPracticeDir);
      const trainingPath = path.join(selfPracticeDir, "EXPERIMENT_JUDGMENTS.jsonl");
      const tinkerPath = path.join(evalsDir, "judgment_tinker_prompt_response.jsonl");
      const evalPath = path.join(evalsDir, "judgment_triage_eval.jsonl");
      const [training, tinker, evalFile] = await Promise.all([jsonlStatus(trainingPath), jsonlStatus(tinkerPath), jsonlStatus(evalPath)]);

      const judgmentByResultVerdict: Record<string, number> = {};
      const judgmentByPromotionVerdict: Record<string, number> = {};
      const judgmentByDataFit: Record<string, number> = {};
      const judgmentByRulesDisclosure: Record<string, number> = {};
      for (const entry of entries) {
        const judgment = entry.judgment;
        if (!judgment) continue;
        increment(judgmentByResultVerdict, asString(judgment.result_verdict) ?? asString(judgment.resultVerdict));
        increment(judgmentByPromotionVerdict, asString(judgment.promotion_verdict) ?? asString(judgment.promotionVerdict));
        increment(judgmentByDataFit, nestedStatus(judgment.data_fit) ?? nestedStatus(judgment.dataFit));
        increment(judgmentByRulesDisclosure, nestedStatus(judgment.rules_disclosure) ?? nestedStatus(judgment.rulesDisclosure));
      }

      return {
        companyId,
        generatedAt,
        source: {
          indexPath: path.normalize(indexFile),
          present: raw !== null,
          stale: ageSeconds !== null ? ageSeconds * 1000 > staleAfterMs : true,
          ageSeconds,
          schema: asString(raw?.schema),
          root: asString(raw?.root),
        },
        counts: {
          total: typeof raw?.entry_count === "number" ? raw.entry_count : entries.length,
          byKind: asStringNumberRecord(raw?.kind_counts),
          byStatus: asStringNumberRecord(raw?.status_counts),
          byDecision: asStringNumberRecord(raw?.decision_counts),
          strategyByDecision: asStringNumberRecord(raw?.strategy_decision_counts),
          evalByVerdict: asStringNumberRecord(raw?.eval_verdict_counts),
          judgmentByResultVerdict,
          judgmentByPromotionVerdict,
          judgmentByDataFit,
          judgmentByRulesDisclosure,
        },
        labels: {
          total: operatorLabels.total,
          experimentsLabeled: operatorLabels.byExperiment.size,
          byLabel: operatorLabels.byLabel,
          labelsPath: path.normalize(labelsFile),
        },
        operatorActions,
        datasetExport: {
          trainingPath: path.normalize(trainingPath),
          trainingRows: training.rows,
          trainingUpdatedUtc: training.updatedUtc,
          tinkerPath: path.normalize(tinkerPath),
          tinkerRows: tinker.rows,
          tinkerUpdatedUtc: tinker.updatedUtc,
          evalPath: path.normalize(evalPath),
          evalRows: evalFile.rows,
          evalUpdatedUtc: evalFile.updatedUtc,
          evalMinLabels: options.evalMinLabels ?? DEFAULT_EVAL_MIN_LABELS,
          labeledJudgments: entries.filter((entry) => entry.judgment && entry.operatorLabels).length,
        },
        recent: entries.slice(0, recentLimit),
        entries,
        safety: {
          readOnly: true,
          brokerActions: false,
          paidComputeActions: false,
          paidDataActions: false,
          signalPublishing: false,
          note: "Reads the local CPS EXPERIMENTS_INDEX.json only; it does not run experiments or touch brokers/paid APIs.",
        },
      };
    },
  };
}
