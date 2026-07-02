// Read-only CPS experiment index scanner.
//
// Exposes the local experiment-tracker JSON produced under CPS self_practice.
// This service never runs experiments, never mutates CPS artifacts, never calls
// brokers/paid APIs, and never publishes signals.

import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateCpsIdeaInput,
  CreateCpsJudgmentFeedbackInput,
  CreateCpsRunRequestInput,
  CpsBacktestQueue,
  CpsBacktestQueueLastTick,
  CpsBacktestQueueSummary,
  CpsDataInventory,
  CpsDataInventoryOhlcvSource,
  CpsDataInventorySubscription,
  CpsDataInventoryTickVenue,
  CpsExperimentEntry,
  CpsToolCatalog,
  CpsToolCatalogEnvironment,
  CpsToolCatalogItem,
  CpsExperimentJudgment,
  CpsExperimentOverview,
  CpsIdeaIntake,
  CpsIdeaSourceType,
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
  backtestQueueDir?: string;
  dataInventoryFile?: string;
  toolCatalogFile?: string;
}

const DEFAULT_SELF_PRACTICE_DIR = "/root/cps/var/self_practice";
const DEFAULT_BACKTEST_QUEUE_DIR = "/root/cps/var/backtest_queue";
const DEFAULT_DATA_INVENTORY_FILE = "/root/cps/var/data_inventory/INVENTORY.json";
// Registry is rebuilt daily by cron; older than 48h means the loop is broken.
const DATA_INVENTORY_STALE_MS = 48 * 60 * 60 * 1000;
const DEFAULT_TOOL_CATALOG_FILE = "/root/cps/var/toolbelt/CATALOG.json";
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
  "decompose_idea",
]);

const IDEA_SOURCE_TYPES: ReadonlySet<CpsIdeaSourceType> = new Set(["x_post", "article", "paper", "other"]);
const IDEA_FETCH_TIMEOUT_MS = 10_000;
const IDEA_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

function assertIdeaInput(input: CreateCpsIdeaInput) {
  if (!IDEA_SOURCE_TYPES.has(input.sourceType)) {
    throw new Error(`Unsupported idea sourceType: ${String(input.sourceType)}`);
  }
  const pasted = input.pastedText?.trim();
  if (!pasted || pasted.length < 20) {
    throw new Error("pastedText is required (paste the idea content — at least 20 characters); it is the snapshot that survives when the page dies");
  }
  if (pasted.length > 200_000) throw new Error("pastedText is too long");
  if (input.url) {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new Error("url must be a valid absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("url must use http or https");
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.endsWith(".local")) {
      throw new Error("url must be a public address");
    }
  }
  if (input.title && input.title.length > 200) throw new Error("title is too long");
  if (input.notes && input.notes.length > 4000) throw new Error("notes are too long");
}

// Best-effort source snapshot at intake time — pages disappear, so we grab the
// URL body immediately. Failure never blocks intake: the operator's pasted text
// (already written) is the canonical snapshot.
async function snapshotIdeaUrl(url: string, dir: string): Promise<{ htmlPath: string | null; fetchStatus: "ok" | "failed"; fetchError: string | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDEA_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; PaperclipIdeaIntake/1.0)" },
      });
      const body = (await response.text()).slice(0, IDEA_SNAPSHOT_MAX_BYTES);
      const htmlPath = path.join(dir, "SNAPSHOT.html");
      await fs.writeFile(htmlPath, body, "utf8");
      await fs.writeFile(path.join(dir, "SNAPSHOT.meta.json"), `${JSON.stringify({
        schema: "cps.idea_snapshot_meta.v1",
        url,
        fetchedAt: new Date().toISOString(),
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        bytes: body.length,
      }, null, 2)}\n`, "utf8");
      if (!response.ok) {
        return { htmlPath: path.normalize(htmlPath), fetchStatus: "failed", fetchError: `HTTP ${response.status}` };
      }
      return { htmlPath: path.normalize(htmlPath), fetchStatus: "ok", fetchError: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { htmlPath: null, fetchStatus: "failed", fetchError: err instanceof Error ? err.message : String(err) };
  }
}

const IDEA_PROGRESS_STAGES = ["intake", "decomposed", "inventory", "data_check", "replication", "oos_validation", "shadow", "dossier"] as const;

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

function resolveBacktestQueueDir(options: CpsExperimentsServiceOptions): string {
  return options.backtestQueueDir ?? process.env.PAPERCLIP_CPS_BACKTEST_QUEUE_DIR ?? DEFAULT_BACKTEST_QUEUE_DIR;
}

function resolveDataInventoryFile(options: CpsExperimentsServiceOptions): string {
  return options.dataInventoryFile ?? process.env.PAPERCLIP_CPS_DATA_INVENTORY_FILE ?? DEFAULT_DATA_INVENTORY_FILE;
}

// E5: read-only view of the unified data inventory registry
// (fincli.data_inventory.v1) written by `pnpm cps:data-inventory`. The board
// only reads the artifact — scanning/refresh stay CLI/cron-side.
async function readDataInventory(options: CpsExperimentsServiceOptions): Promise<CpsDataInventory> {
  const registryPath = resolveDataInventoryFile(options);
  const absent: CpsDataInventory = {
    present: false,
    registryPath: path.normalize(registryPath),
    generatedUtc: null,
    stale: true,
    totalBytes: null,
    inventoryFirstRule: null,
    tickVenues: [],
    ohlcvSources: [],
    staleSources: [],
    subscriptions: [],
  };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as unknown;
  } catch {
    return absent;
  }
  const reg = asRecord(raw);
  if (!reg || !String(reg.schema ?? "").startsWith("fincli.data_inventory.")) return absent;
  const tiers = asRecord(reg.tiers) ?? {};
  const tickTier = asRecord(tiers.tick_recorders) ?? {};
  const ohlcvTier = asRecord(tiers.ohlcv_cache) ?? {};
  const summary = asRecord(reg.summary) ?? {};
  const subMap = asRecord(reg.subscription_map) ?? {};
  const generatedUtc = asString(reg.generated_utc);
  const generatedMs = parseDateMs(generatedUtc);
  const tickVenues: CpsDataInventoryTickVenue[] = (Array.isArray(tickTier.venues) ? tickTier.venues : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        venue: asString(rec.venue) ?? "unknown",
        symbols: asStringArray(rec.symbols) ?? [],
        streams: asStringArray(rec.streams) ?? [],
        earliestDate: asString(rec.earliest_date),
        latestDate: asString(rec.latest_date),
        days: typeof rec.days === "number" ? rec.days : null,
        bytes: typeof rec.bytes === "number" ? rec.bytes : null,
        live: rec.live === true,
      };
    })
    .filter((v): v is CpsDataInventoryTickVenue => v !== null);
  const ohlcvSources: CpsDataInventoryOhlcvSource[] = (Array.isArray(ohlcvTier.sources) ? ohlcvTier.sources : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        dataset: asString(rec.dataset) ?? "unknown",
        schema: asString(rec.schema) ?? "unknown",
        symbol: asString(rec.symbol) ?? "unknown",
        start: asString(rec.start),
        end: asString(rec.end),
        files: typeof rec.files === "number" ? rec.files : null,
        bytes: typeof rec.bytes === "number" ? rec.bytes : null,
        fresh: rec.fresh === true,
      };
    })
    .filter((s): s is CpsDataInventoryOhlcvSource => s !== null);
  const subscriptions: CpsDataInventorySubscription[] = (Array.isArray(subMap.entries) ? subMap.entries : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        provider: asString(rec.provider) ?? "unknown",
        subscription: asString(rec.subscription) ?? "unknown",
        status: asString(rec.status) ?? "unknown",
        unlocks: asString(rec.unlocks) ?? "",
        link: asString(rec.link) ?? "",
      };
    })
    .filter((s): s is CpsDataInventorySubscription => s !== null);
  return {
    present: true,
    registryPath: path.normalize(registryPath),
    generatedUtc: generatedUtc ?? null,
    stale: generatedMs === null ? true : Date.now() - generatedMs > DATA_INVENTORY_STALE_MS,
    totalBytes: typeof summary.total_bytes === "number" ? summary.total_bytes : null,
    inventoryFirstRule: asString(reg.inventory_first_rule),
    tickVenues,
    ohlcvSources,
    staleSources: asStringArray(summary.stale_sources) ?? [],
    subscriptions,
  };
}

function resolveToolCatalogFile(options: CpsExperimentsServiceOptions): string {
  return options.toolCatalogFile ?? process.env.PAPERCLIP_CPS_TOOL_CATALOG_FILE ?? DEFAULT_TOOL_CATALOG_FILE;
}

// E7: read-only view of the tool catalog (fincli.tool_catalog.v1) written by
// `pnpm cps:tool-catalog`. The board only reads the artifact — scanning stays
// CLI/cron-side; nothing is installed from here.
async function readToolCatalog(options: CpsExperimentsServiceOptions): Promise<CpsToolCatalog> {
  const catalogPath = resolveToolCatalogFile(options);
  const absent: CpsToolCatalog = {
    present: false,
    catalogPath: path.normalize(catalogPath),
    generatedUtc: null,
    stale: true,
    environments: [],
    recorders: [],
    services: [],
    enginesAndAdapters: [],
    executionPlane: null,
    notReady: [],
  };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(catalogPath, "utf8")) as unknown;
  } catch {
    return absent;
  }
  const cat = asRecord(raw);
  if (!cat || !String(cat.schema ?? "").startsWith("fincli.tool_catalog.")) return absent;
  const sections = asRecord(cat.sections) ?? {};
  const summary = asRecord(cat.summary) ?? {};
  const generatedUtc = asString(cat.generated_utc);
  const generatedMs = parseDateMs(generatedUtc);
  const environments: CpsToolCatalogEnvironment[] = (Array.isArray(sections.python_environments) ? sections.python_environments : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        name: asString(rec.name) ?? "unknown",
        ready: rec.ready === true,
        status: asString(rec.status),
        toolCount: typeof rec.tool_count === "number" ? rec.tool_count : null,
        importOk: typeof rec.import_ok === "number" ? rec.import_ok : null,
        failedImports: asStringArray(rec.failed_imports) ?? [],
      };
    })
    .filter((e): e is CpsToolCatalogEnvironment => e !== null);
  const recorders: CpsToolCatalogItem[] = (Array.isArray(sections.recorders) ? sections.recorders : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        name: asString(rec.name) ?? "unknown",
        kind: "recorder",
        ok: rec.live === true,
        detail: (asStringArray(rec.symbols) ?? []).join(", ") || null,
      };
    })
    .filter((r): r is CpsToolCatalogItem => r !== null);
  const services: CpsToolCatalogItem[] = (Array.isArray(sections.services) ? sections.services : [])
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      return {
        name: asString(rec.name) ?? "unknown",
        kind: "service",
        ok: rec.listening === true,
        detail: typeof rec.port === "number" ? `port ${rec.port}` : null,
      };
    })
    .filter((s): s is CpsToolCatalogItem => s !== null);
  const anchorItems = (key: "engines" | "broker_adapters"): CpsToolCatalogItem[] =>
    (Array.isArray(sections[key]) ? sections[key] as unknown[] : [])
      .map((item) => {
        const rec = asRecord(item);
        if (!rec) return null;
        return {
          name: asString(rec.name) ?? "unknown",
          kind: asString(rec.kind) ?? "engine",
          ok: rec.anchor_present === true,
          detail: asString(rec.notes),
        };
      })
      .filter((a): a is CpsToolCatalogItem => a !== null);
  const execution = asRecord(sections.execution_plane);
  const executionPlane = execution
    ? `NautilusTrader ${asString(execution.production_pin) ?? "?"} at ${asString(execution.production_root) ?? "?"} [${asString(execution.status) ?? "?"}]`
    : null;
  return {
    present: true,
    catalogPath: path.normalize(catalogPath),
    generatedUtc: generatedUtc ?? null,
    stale: generatedMs === null ? true : Date.now() - generatedMs > DATA_INVENTORY_STALE_MS,
    environments,
    recorders,
    services,
    enginesAndAdapters: [...anchorItems("engines"), ...anchorItems("broker_adapters")],
    executionPlane,
    notReady: asStringArray(summary.not_ready) ?? [],
  };
}

// E1: read-only view of the shared pod backtest queue (fincli.backtest_queue.v1)
// written by tools/backtest_queue.py + the supervised dispatcher tick. The board
// only reads state here — submission/dispatch stay CLI/cron-side.
async function readBacktestQueue(options: CpsExperimentsServiceOptions): Promise<CpsBacktestQueue> {
  const queueDir = resolveBacktestQueueDir(options);
  const queuePath = path.join(queueDir, "queue.json");
  const tickPath = path.join(queueDir, "LAST_TICK.json");
  const stopPath = path.join(queueDir, "STOP");
  const empty: CpsBacktestQueueSummary = {
    total: 0, pending: 0, leased: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0,
  };

  let present = false;
  let updatedUtc: string | null = null;
  let summary: CpsBacktestQueueSummary | null = null;
  let oldestPendingAgeSeconds: number | null = null;
  try {
    const raw = JSON.parse(await fs.readFile(queuePath, "utf8")) as unknown;
    const queue = asRecord(raw);
    if (queue && queue.schema === "fincli.backtest_queue.v1") {
      present = true;
      updatedUtc = asString(queue.updated_utc);
      const counts = { ...empty };
      const now = Date.now();
      const pendingAges: number[] = [];
      for (const item of Array.isArray(queue.requests) ? queue.requests : []) {
        const req = asRecord(item);
        if (!req) continue;
        counts.total += 1;
        const status = (asString(req.status) ?? "").toUpperCase();
        if (status === "PENDING") counts.pending += 1;
        else if (status === "LEASED") counts.leased += 1;
        else if (status === "RUNNING") counts.running += 1;
        else if (status === "COMPLETED") counts.completed += 1;
        else if (status === "FAILED") counts.failed += 1;
        else if (status === "BLOCKED") counts.blocked += 1;
        else if (status === "CANCELLED") counts.cancelled += 1;
        if (status === "PENDING") {
          const createdMs = parseDateMs(asString(req.created_utc));
          if (createdMs !== null) pendingAges.push(Math.max(0, Math.round((now - createdMs) / 1000)));
        }
      }
      summary = counts;
      oldestPendingAgeSeconds = pendingAges.length ? Math.max(...pendingAges) : null;
    }
  } catch {
    // queue not created yet — report as absent, not an error
  }

  let lastTick: CpsBacktestQueueLastTick | null = null;
  try {
    const raw = JSON.parse(await fs.readFile(tickPath, "utf8")) as unknown;
    const tick = asRecord(raw);
    if (tick) {
      const probed: Record<string, string> = {};
      const probedRaw = asRecord(tick.probed_workers) ?? {};
      for (const [worker, state] of Object.entries(probedRaw)) {
        if (typeof state === "string") probed[worker] = state;
      }
      lastTick = {
        status: asString(tick.status),
        atUtc: asString(tick.generated_utc),
        probedWorkers: probed,
        reachableWorkers: asStringArray(tick.reachable_workers),
        leased: (Array.isArray(tick.leased) ? tick.leased : []).map((item) => {
          const lease = asRecord(item) ?? {};
          return {
            requestId: asString(lease.request_id),
            worker: asString(lease.worker),
            pod: asString(lease.pod),
          };
        }),
      };
    }
  } catch {
    // no tick yet
  }

  let stopPresent = false;
  try {
    await fs.stat(stopPath);
    stopPresent = true;
  } catch {
    stopPresent = false;
  }

  const starving = (summary?.pending ?? 0) > 0 && lastTick !== null && lastTick.reachableWorkers.length === 0;
  return {
    present,
    queuePath: path.normalize(queuePath),
    updatedUtc,
    summary,
    oldestPendingAgeSeconds,
    lastTick,
    stopPresent,
    starving,
  };
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

    // E3: idea intake. Writes the idea dir under self_practice (so it is indexed
    // and rendered like any experiment), snapshots the source, seeds PROGRESS.json
    // (intake done), and queues a bounded decompose_idea run request for the
    // */15 CPS consumer. No research, no network beyond the one snapshot fetch.
    async createIdeaIntake(companyId: string, input: CreateCpsIdeaInput): Promise<CpsIdeaIntake> {
      assertIdeaInput(input);
      const createdAt = new Date().toISOString();
      const selfPracticeDir = options.selfPracticeDir ?? process.env.PAPERCLIP_CPS_SELF_PRACTICE_DIR ?? DEFAULT_SELF_PRACTICE_DIR;
      const title = input.title?.trim() || null;
      const pastedText = input.pastedText.trim();
      const slugBasis = title ?? pastedText.split(/\s+/).slice(0, 6).join(" ");
      const id = `idea-${createdAt.replace(/[-:.]/g, "").slice(0, 15)}-${safeSlug(slugBasis).slice(0, 60)}`;
      const dir = path.join(selfPracticeDir, id);
      await fs.mkdir(dir, { recursive: false });

      const pastedTextPath = path.join(dir, "SOURCE.txt");
      await fs.writeFile(pastedTextPath, `${pastedText}\n`, { flag: "wx" });

      let snapshot: CpsIdeaIntake["snapshot"] = {
        pastedTextPath: path.normalize(pastedTextPath),
        htmlPath: null,
        fetchStatus: "skipped",
        fetchError: null,
      };
      if (input.url) {
        const fetched = await snapshotIdeaUrl(input.url, dir);
        snapshot = { ...snapshot, ...fetched };
      }

      const progressPath = path.join(dir, "PROGRESS.json");
      await fs.writeFile(progressPath, `${JSON.stringify({
        schema: "cps.paper_progress.v1",
        paper_id: id,
        updated_utc: createdAt,
        generated_by: "board-idea-intake.v1",
        stages: IDEA_PROGRESS_STAGES.map((stage) => ({
          stage,
          status: stage === "intake" ? "done" : stage === "decomposed" ? "in_progress" : "pending",
          ...(stage === "intake" ? { at: createdAt } : {}),
        })),
      }, null, 2)}\n`, { flag: "wx" });

      const runRequest = await this.createRunRequest(companyId, {
        action: "decompose_idea",
        experimentId: id,
        prompt: `Decompose the board idea in ${id}: extract the verbatim claim, instruments, timeframe, and data needs from SOURCE.txt; route to the right pod; register in the don't-test-twice ledger. Mark anything not literally present as UNKNOWN — never invent rules.`,
        maxRuntimeMinutes: 15,
      });

      const idea: CpsIdeaIntake = {
        schema: "cps.idea_intake.v1",
        id,
        companyId,
        sourceType: input.sourceType,
        title,
        url: input.url?.trim() || null,
        notes: input.notes?.trim() || null,
        createdAt,
        createdBy: "board",
        dir: path.normalize(dir),
        snapshot,
        runRequestId: runRequest.id,
        progressPath: path.normalize(progressPath),
      };
      await fs.writeFile(path.join(dir, "IDEA.json"), `${JSON.stringify(idea, null, 2)}\n`, { flag: "wx" });
      return idea;
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
      const [training, tinker, evalFile, backtestQueue, dataInventory, toolCatalog] = await Promise.all([
        jsonlStatus(trainingPath),
        jsonlStatus(tinkerPath),
        jsonlStatus(evalPath),
        readBacktestQueue(options),
        readDataInventory(options),
        readToolCatalog(options),
      ]);

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
        backtestQueue,
        dataInventory,
        toolCatalog,
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
