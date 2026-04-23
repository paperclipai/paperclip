import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access, constants as fsConstants } from "node:fs/promises";
import { join as pathJoin, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  LEDGER_DOC_KEY,
  PLUGIN_ID,
  RECEIPT_DOC_KEY,
  STREAM_CHANNELS,
  TRANSCRIPT_DOC_KEY,
} from "./manifest.js";

/**
 * Paperclip "Truth Extract" example plugin worker.
 *
 * THIN BINDING. This plugin does not re-author Layer B (claims → brief →
 * frozen export). It invokes proposal-forge's `truth:*` artisan commands via
 * local subprocess under PAPERCLIP_TRUTH_FORGE_PATH and records run IDs,
 * brief IDs, export IDs, SHA256 hashes, and gate verdicts into
 * `proposal-forge.receipt.json` on the Paperclip issue.
 *
 * Layer A (transcript → ledger.json) is frozen-v1 in the
 * paperclip-truth-extract skill. The caller attaches `ledger.json` to the
 * issue before invoking the forge chain. This plugin does not auto-invoke
 * Layer A.
 *
 * Human gates (atom review, claim review) are surfaced as explicit
 * attestation actions, never auto-run and never synthesized around.
 *
 * Full contract: skills/paperclip-truth-extract/references/thin-binding.md
 */

const execFileAsync = promisify(execFile);

const FORGE_HEAD_SHA_PIN = "93456af";
const RECEIPT_VERSION = 1;
const SKILL_VERSION = "paperclip-truth-extract@frozen-v1";

// --- Types ---------------------------------------------------------------

type ParsedStep = Record<string, unknown> | null;

type ForgeSubprocessStep = {
  step: number;
  command: string;
  args: Record<string, unknown>;
  started_at: string;
  completed_at: string;
  exit_code: number;
  stdout_doc_key: string;
  parsed: ParsedStep;
  parse_miss?: true;
};

type ForgeAttestationStep = {
  step: number;
  command: string;
  gate: "atom_review" | "claim_review";
  mode: "manual_attestation";
  operator: string;
  attested_at: string;
  note?: string;
};

type ForgeStep = ForgeSubprocessStep | ForgeAttestationStep;

type Receipt = {
  receipt_version: number;
  skill_version: string;
  forge_path: string | null;
  forge_head_sha_pin: string;
  observed_forge_head_sha: string | null;
  transcript_doc_key: string;
  ledger_doc_key: string;
  transcript_file_path: string | null;
  ledger_file_path: string | null;
  steps: ForgeStep[];
  archival_complete: boolean;
  buyer_facing_complete: false;
  buyer_facing_unsupported_reason: string;
};

// --- Utilities -----------------------------------------------------------

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return String(value ?? "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function wrapJsonInMarkdown(title: string, body: unknown): string {
  const json = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return [`# ${title}`, "", "```json", json, "```"].join("\n");
}

function extractFencedJson(body: string): unknown | null {
  const fenceMatch =
    body.match(/```json\s*\n([\s\S]*?)\n```/i) ??
    body.match(/```\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) return null;
  try {
    return JSON.parse(fenceMatch[1]);
  } catch {
    return null;
  }
}

function wrapTextInMarkdown(title: string, body: string): string {
  return [`# ${title}`, "", "```", body, "```"].join("\n");
}

async function pathIsReadable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveForgePath(): Promise<string> {
  const raw = process.env.PAPERCLIP_TRUTH_FORGE_PATH;
  if (!raw || raw.length === 0) {
    throw new Error(
      "PAPERCLIP_TRUTH_FORGE_PATH is not set. Point it at the absolute path of a local proposal-forge checkout.",
    );
  }
  if (!isAbsolute(raw)) {
    throw new Error(
      `PAPERCLIP_TRUTH_FORGE_PATH must be absolute. Got: ${raw}`,
    );
  }
  const artisan = pathJoin(raw, "artisan");
  if (!(await pathIsReadable(artisan))) {
    throw new Error(
      `proposal-forge artisan not readable at ${artisan}. Check PAPERCLIP_TRUTH_FORGE_PATH.`,
    );
  }
  return raw;
}

/**
 * Return the full git HEAD SHA for the forge checkout. Throws if git is not
 * available or the path is not a repo.
 */
async function readForgeHeadSha(forgePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: forgePath,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to read git HEAD at ${forgePath}: ${msg}. proposal-forge must be a git checkout so the pin can be verified.`,
    );
  }
}

/**
 * Verify that the forge checkout is at the pinned SHA. Refuse to run if not.
 * There is no bypass — bumping FORGE_HEAD_SHA_PIN requires a code change,
 * which is visible in diff and subject to review. Pre-filing, this is the
 * guarantee that the receipt's claimed pin reflects what actually ran.
 */
async function verifyForgePin(forgePath: string): Promise<string> {
  const observed = await readForgeHeadSha(forgePath);
  if (!observed.startsWith(FORGE_HEAD_SHA_PIN)) {
    throw new Error(
      `proposal-forge HEAD mismatch. Expected pin ${FORGE_HEAD_SHA_PIN}…, observed ${observed}. ` +
        `Check out ${FORGE_HEAD_SHA_PIN} in ${forgePath}, or bump FORGE_HEAD_SHA_PIN in the plugin source (code change required, no env bypass).`,
    );
  }
  return observed;
}

async function workDirFor(issueId: string): Promise<string> {
  const base =
    process.env.PAPERCLIP_TRUTH_WORK_DIR ??
    pathJoin(tmpdir(), "paperclip-truth-extract");
  const dir = pathJoin(base, issueId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// --- Receipt IO ----------------------------------------------------------

function emptyReceipt(
  forgePath: string | null,
  observedForgeHeadSha: string | null,
  transcriptFilePath: string | null,
  ledgerFilePath: string | null,
): Receipt {
  return {
    receipt_version: RECEIPT_VERSION,
    skill_version: SKILL_VERSION,
    forge_path: forgePath,
    forge_head_sha_pin: FORGE_HEAD_SHA_PIN,
    observed_forge_head_sha: observedForgeHeadSha,
    transcript_doc_key: TRANSCRIPT_DOC_KEY,
    ledger_doc_key: LEDGER_DOC_KEY,
    transcript_file_path: transcriptFilePath,
    ledger_file_path: ledgerFilePath,
    steps: [],
    archival_complete: false,
    buyer_facing_complete: false,
    buyer_facing_unsupported_reason:
      "truth:review-brief does not exist in proposal-forge; buyer-facing completion is unsupported in this binding.",
  };
}

async function readReceipt(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<Receipt> {
  const doc = await ctx.issues.documents.get(issueId, RECEIPT_DOC_KEY, companyId);
  if (!doc || typeof doc.body !== "string") {
    throw new Error(
      `No ${RECEIPT_DOC_KEY} on issue ${issueId}. Call create-run first.`,
    );
  }
  const parsed = extractFencedJson(doc.body);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Receipt on issue ${issueId} is not parseable JSON. Refuse to continue.`,
    );
  }
  return parsed as Receipt;
}

async function writeReceipt(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  receipt: Receipt,
  changeSummary: string,
): Promise<void> {
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: RECEIPT_DOC_KEY,
    body: wrapJsonInMarkdown("proposal-forge receipt", receipt),
    title: "proposal-forge receipt",
    changeSummary,
  });
}

function markArchivalComplete(receipt: Receipt): void {
  const hasImport = receipt.steps.some(
    (s) => "exit_code" in s && s.command === "truth:import-liberty-ledger" && s.exit_code === 0,
  );
  const hasClaims = receipt.steps.some(
    (s) => "exit_code" in s && s.command === "truth:synthesize-claims" && s.exit_code === 0,
  );
  const hasBrief = receipt.steps.some(
    (s) => "exit_code" in s && s.command === "truth:synthesize-brief" && s.exit_code === 0,
  );
  const hasFreeze = receipt.steps.some(
    (s) => "exit_code" in s && s.command === "truth:freeze-export" && s.exit_code === 0,
  );
  receipt.archival_complete = hasImport && hasClaims && hasBrief && hasFreeze;
}

// --- Subprocess + parse --------------------------------------------------

async function runArtisan(
  forgePath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("php", ["artisan", ...args], {
      cwd: forgePath,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    // execFileAsync rejects with err.stdout / err.stderr / err.code set.
    const anyErr = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: anyErr.stdout ?? "",
      stderr: anyErr.stderr ?? anyErr.message ?? "",
      exitCode: typeof anyErr.code === "number" ? anyErr.code : 1,
    };
  }
}

function parseImport(stdout: string): ParsedStep {
  const m = stdout.match(/truth_run #(\d+) imported/);
  if (!m) return null;
  return { run_id: Number(m[1]) };
}

function parseSynthesizeClaims(stdout: string): ParsedStep {
  const run = stdout.match(
    /synthesis_run #(\d+) · status=(\S+) · tokens (\d+) in \/ (\d+) out/,
  );
  const counts = stdout.match(
    /claims: (\d+) emitted by model · (\d+) passed verifier · (\d+) persisted · (\d+) rejected/,
  );
  if (!run) return null;
  return {
    synthesis_run_id: Number(run[1]),
    status: run[2],
    tokens_in: Number(run[3]),
    tokens_out: Number(run[4]),
    claims_emitted: counts ? Number(counts[1]) : null,
    claims_passed_verifier: counts ? Number(counts[2]) : null,
    claims_persisted: counts ? Number(counts[3]) : null,
    claims_rejected: counts ? Number(counts[4]) : null,
  };
}

function parseSynthesizeBrief(stdout: string): ParsedStep {
  const brief = stdout.match(
    /brief #(\d+) \(v(\d+)\) created · status=(\S+) · tokens (\d+) in \/ (\d+) out/,
  );
  if (!brief) return null;
  const payloadHash = stdout.match(/brief_payload_hash: (\w+)/);
  const inputHash = stdout.match(/synthesis_run #\d+ · input_hash: (\w+)/);
  const sectionCounts: Record<string, [number, number]> = {};
  for (const m of stdout.matchAll(/\s+\S{2}\s+(\S+)\s+(\d+) \/ (\d+)/g)) {
    // matches lines like "  OK problem                    5 / 5"
    const key = m[1];
    const actual = Number(m[2]);
    const expected = Number(m[3]);
    // Only accept known section keys to avoid grabbing unrelated lines.
    if (
      [
        "problem",
        "constraint",
        "opportunity",
        "pilot",
        "problem_statement",
        "buyer_value_narrative",
      ].includes(key)
    ) {
      sectionCounts[key] = [actual, expected];
    }
  }
  return {
    brief_id: Number(brief[1]),
    brief_version: Number(brief[2]),
    brief_status: brief[3],
    tokens_in: Number(brief[4]),
    tokens_out: Number(brief[5]),
    brief_payload_hash: payloadHash ? payloadHash[1] : null,
    synthesis_input_hash: inputHash ? inputHash[1] : null,
    section_counts: sectionCounts,
  };
}

function parseFreezeExport(stdout: string): ParsedStep {
  const verdict = stdout.match(/release gate verdict: (\S+)/);
  if (!verdict) return null;

  type Gate = {
    gate: number;
    name: string;
    status: string;
    findings: Array<{ severity: string; code: string; message: string }>;
  };
  const gates: Gate[] = [];

  // Walk stdout line-by-line so each finding attaches to the gate header
  // that most recently preceded it (FreezeExport.php emits the gate line,
  // then zero or more indented finding lines, then the next gate). Two-pass
  // matchAll parsing misattributes all findings to the last gate.
  const gateLineRegex = /gate (\d+) · (\S[^·]*?)\s+(PASS|WARN|FAIL)\s*$/;
  const findingLineRegex = /^\s+\[(\w+)\]\s+(\S+)\s+·\s+(.*)$/;
  let currentGate: Gate | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const gateMatch = rawLine.match(gateLineRegex);
    if (gateMatch) {
      currentGate = {
        gate: Number(gateMatch[1]),
        name: gateMatch[2].trim(),
        status: gateMatch[3],
        findings: [],
      };
      gates.push(currentGate);
      continue;
    }
    const findingMatch = rawLine.match(findingLineRegex);
    if (findingMatch && currentGate) {
      currentGate.findings.push({
        severity: findingMatch[1],
        code: findingMatch[2],
        message: findingMatch[3].trim(),
      });
    }
  }

  const exports: Array<{
    export_id: number;
    format: string;
    version: number;
    sha256: string;
    bytes: number;
  }> = [];
  for (const e of stdout.matchAll(
    /export #(\d+) · format=(\S+) v(\d+) · sha256=(\w+) · (\d+) bytes/g,
  )) {
    exports.push({
      export_id: Number(e[1]),
      format: e[2],
      version: Number(e[3]),
      sha256: e[4],
      bytes: Number(e[5]),
    });
  }
  return {
    gate_verdict: verdict[1],
    gates,
    exports,
  };
}

// --- Action: create-run --------------------------------------------------

type CreateRunParams = {
  companyId?: unknown;
  title?: unknown;
  transcriptJson?: unknown;
  ledgerJson?: unknown;
};

type CreateRunResult = {
  issueId: string;
  transcriptFilePath: string;
  ledgerFilePath: string;
};

async function normalizeToJsonString(
  value: unknown,
  label: string,
): Promise<string> {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required`);
  }
  if (typeof value === "string") {
    // validate — refuse garbage
    try {
      JSON.parse(value);
    } catch {
      throw new Error(`${label} must be valid JSON`);
    }
    return value;
  }
  return JSON.stringify(value, null, 2);
}

async function createRun(
  ctx: PluginContext,
  params: CreateRunParams,
): Promise<CreateRunResult> {
  const companyId = requireString(params.companyId, "companyId");
  const transcriptStr = await normalizeToJsonString(
    params.transcriptJson,
    "transcriptJson",
  );
  const ledgerStr = await normalizeToJsonString(params.ledgerJson, "ledgerJson");

  const transcriptArr = JSON.parse(transcriptStr);
  const utteranceCount = Array.isArray(transcriptArr) ? transcriptArr.length : 0;

  const title =
    maybeString(params.title) ??
    `proposal-forge archival (${utteranceCount} utterances)`;

  // Pre-validate env AND pin before creating an issue we'd need to clean up later.
  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);

  const issue = await ctx.issues.create({
    companyId,
    title,
    description: [
      "proposal-forge archival run (Layer B).",
      "",
      "Layer A ledger was produced by the paperclip-truth-extract skill",
      "(frozen-v1) and is attached as `ledger.json`.",
      "",
      "Each proposal-forge step will append to `proposal-forge.receipt.json`.",
      "",
      "Buyer-facing completion is intentionally unsupported by this plugin;",
      "the archival chain ends at `truth:freeze-export`.",
    ].join("\n"),
  });

  // Persist inputs as issue documents (markdown-wrapped JSON).
  await ctx.issues.documents.upsert({
    issueId: issue.id,
    companyId,
    key: TRANSCRIPT_DOC_KEY,
    body: wrapJsonInMarkdown("Transcript (utterances)", transcriptStr),
    title: "Source transcript",
    changeSummary: "plugin-truth-extract: transcript ingested",
  });
  await ctx.issues.documents.upsert({
    issueId: issue.id,
    companyId,
    key: LEDGER_DOC_KEY,
    body: wrapJsonInMarkdown("Layer A ledger (paperclip-truth-extract v1)", ledgerStr),
    title: "Layer A ledger",
    changeSummary: "plugin-truth-extract: ledger ingested",
  });

  // Write disk-side files for the artisan command to read.
  const workDir = await workDirFor(issue.id);
  const transcriptFilePath = pathJoin(workDir, "transcript.json");
  const ledgerFilePath = pathJoin(workDir, "ledger.recovered.json");
  await writeFile(transcriptFilePath, transcriptStr, "utf8");
  await writeFile(ledgerFilePath, ledgerStr, "utf8");

  const receipt = emptyReceipt(
    forgePath,
    observedHead,
    transcriptFilePath,
    ledgerFilePath,
  );
  await writeReceipt(
    ctx,
    companyId,
    issue.id,
    receipt,
    "plugin-truth-extract: receipt initialized",
  );

  ctx.streams.open(STREAM_CHANNELS.progress, companyId);
  ctx.streams.emit(STREAM_CHANNELS.progress, {
    issueId: issue.id,
    stage: "run-created",
    transcriptFilePath,
    ledgerFilePath,
  });

  return { issueId: issue.id, transcriptFilePath, ledgerFilePath };
}

// --- Action: forge-import ------------------------------------------------

type ForgeIssueRef = { companyId?: unknown; issueId?: unknown };

async function forgeImport(
  ctx: PluginContext,
  params: ForgeIssueRef & { title?: unknown },
): Promise<{ run_id: number | null; exit_code: number }> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");

  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);
  const receipt = await readReceipt(ctx, companyId, issueId);
  if (!receipt.transcript_file_path || !receipt.ledger_file_path) {
    throw new Error("Receipt missing transcript_file_path or ledger_file_path");
  }

  const title =
    maybeString(params.title) ?? `paperclip archival run — issue ${issueId}`;
  const args = [
    "truth:import-liberty-ledger",
    `--transcript=${receipt.transcript_file_path}`,
    `--ledger=${receipt.ledger_file_path}`,
    `--title=${title}`,
  ];
  const started = nowIso();
  const { stdout, stderr, exitCode } = await runArtisan(forgePath, args);
  const completed = nowIso();

  const stdoutKey = `forge.step-1-import.stdout.txt`;
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: stdoutKey,
    body: wrapTextInMarkdown("truth:import-liberty-ledger stdout/stderr", [
      "=== stdout ===",
      stdout,
      "",
      "=== stderr ===",
      stderr,
    ].join("\n")),
    title: "forge step 1 — import (stdout)",
    changeSummary: `plugin-truth-extract: truth:import-liberty-ledger exit=${exitCode}`,
  });

  const parsed = exitCode === 0 ? parseImport(stdout) : null;
  const step: ForgeSubprocessStep = {
    step: 1,
    command: "truth:import-liberty-ledger",
    args: {
      transcript: receipt.transcript_file_path,
      ledger: receipt.ledger_file_path,
      title,
      forge_head_sha_observed: observedHead,
    },
    started_at: started,
    completed_at: completed,
    exit_code: exitCode,
    stdout_doc_key: stdoutKey,
    parsed,
  };
  if (exitCode === 0 && parsed === null) step.parse_miss = true;
  receipt.steps.push(step);
  markArchivalComplete(receipt);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 1 import · exit=${exitCode}`,
  );

  return {
    run_id: parsed && typeof parsed.run_id === "number" ? parsed.run_id : null,
    exit_code: exitCode,
  };
}

// --- Action: forge-bulk-accept-atoms -------------------------------------

async function forgeBulkAcceptAtoms(
  ctx: PluginContext,
  params: ForgeIssueRef,
): Promise<{ exit_code: number }> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);
  const receipt = await readReceipt(ctx, companyId, issueId);
  const runId = findRunId(receipt);
  if (runId === null) throw new Error("No run_id in receipt; run forge-import first");

  const args = ["truth:bulk-accept-atoms", `--run=${runId}`];
  const started = nowIso();
  const { stdout, stderr, exitCode } = await runArtisan(forgePath, args);
  const completed = nowIso();

  const stdoutKey = "forge.step-2-bulk-accept.stdout.txt";
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: stdoutKey,
    body: wrapTextInMarkdown("truth:bulk-accept-atoms stdout/stderr", [
      "=== stdout ===",
      stdout,
      "",
      "=== stderr ===",
      stderr,
    ].join("\n")),
    title: "forge step 2 — bulk accept atoms (stdout)",
    changeSummary: `plugin-truth-extract: truth:bulk-accept-atoms exit=${exitCode}`,
  });

  const step: ForgeSubprocessStep = {
    step: 2,
    command: "truth:bulk-accept-atoms",
    args: { run: runId, forge_head_sha_observed: observedHead },
    started_at: started,
    completed_at: completed,
    exit_code: exitCode,
    stdout_doc_key: stdoutKey,
    parsed: null,
  };
  receipt.steps.push(step);
  markArchivalComplete(receipt);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 2 bulk-accept-atoms · exit=${exitCode}`,
  );

  return { exit_code: exitCode };
}

// --- Action: forge-attest-atom-review ------------------------------------

async function forgeAttestAtomReview(
  ctx: PluginContext,
  params: ForgeIssueRef & { operator?: unknown; note?: unknown },
): Promise<void> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const operator = requireString(params.operator, "operator");
  const note = maybeString(params.note);

  const receipt = await readReceipt(ctx, companyId, issueId);
  const step: ForgeAttestationStep = {
    step: 2,
    // No artisan command exists for manual atom review — `truth:bulk-accept-atoms`
    // is the only CLI-level acceptance path. Manual review happens via the
    // proposal-forge UI or direct database work; this step only records
    // operator attestation that it was done.
    command: "atom_review (manual, no CLI)",
    gate: "atom_review",
    mode: "manual_attestation",
    operator,
    attested_at: nowIso(),
    ...(note ? { note } : {}),
  };
  receipt.steps.push(step);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 2 atom review attested by ${operator}`,
  );
}

// --- Action: forge-synthesize-claims -------------------------------------

async function forgeSynthesizeClaims(
  ctx: PluginContext,
  params: ForgeIssueRef & { mode?: unknown; model?: unknown },
): Promise<{ synthesis_run_id: number | null; exit_code: number }> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const mode = maybeString(params.mode) ?? "standard";
  const model = maybeString(params.model) ?? "gpt-5.4-mini";

  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);
  const receipt = await readReceipt(ctx, companyId, issueId);
  const runId = findRunId(receipt);
  if (runId === null) throw new Error("No run_id in receipt; run forge-import first");

  const args = [
    "truth:synthesize-claims",
    `--run=${runId}`,
    `--mode=${mode}`,
    `--model=${model}`,
  ];
  const started = nowIso();
  const { stdout, stderr, exitCode } = await runArtisan(forgePath, args);
  const completed = nowIso();

  const stdoutKey = "forge.step-3-claims.stdout.txt";
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: stdoutKey,
    body: wrapTextInMarkdown("truth:synthesize-claims stdout/stderr", [
      "=== stdout ===",
      stdout,
      "",
      "=== stderr ===",
      stderr,
    ].join("\n")),
    title: "forge step 3 — synthesize claims (stdout)",
    changeSummary: `plugin-truth-extract: truth:synthesize-claims exit=${exitCode}`,
  });

  const parsed = exitCode === 0 ? parseSynthesizeClaims(stdout) : null;
  const step: ForgeSubprocessStep = {
    step: 3,
    command: "truth:synthesize-claims",
    args: { run: runId, mode, model, forge_head_sha_observed: observedHead },
    started_at: started,
    completed_at: completed,
    exit_code: exitCode,
    stdout_doc_key: stdoutKey,
    parsed,
  };
  if (exitCode === 0 && parsed === null) step.parse_miss = true;
  receipt.steps.push(step);
  markArchivalComplete(receipt);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 3 synthesize-claims · exit=${exitCode}`,
  );

  return {
    synthesis_run_id:
      parsed && typeof parsed.synthesis_run_id === "number"
        ? parsed.synthesis_run_id
        : null,
    exit_code: exitCode,
  };
}

// --- Action: forge-attest-claim-review -----------------------------------

async function forgeAttestClaimReview(
  ctx: PluginContext,
  params: ForgeIssueRef & { operator?: unknown; note?: unknown },
): Promise<void> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const operator = requireString(params.operator, "operator");
  const note = maybeString(params.note);

  const receipt = await readReceipt(ctx, companyId, issueId);
  const step: ForgeAttestationStep = {
    step: 4,
    command: "truth:review-claims (interactive, human)",
    gate: "claim_review",
    mode: "manual_attestation",
    operator,
    attested_at: nowIso(),
    ...(note ? { note } : {}),
  };
  receipt.steps.push(step);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 4 claim review attested by ${operator}`,
  );
}

// --- Action: forge-synthesize-brief --------------------------------------

async function forgeSynthesizeBrief(
  ctx: PluginContext,
  params: ForgeIssueRef & { title?: unknown; model?: unknown },
): Promise<{ brief_id: number | null; brief_payload_hash: string | null; exit_code: number }> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const model = maybeString(params.model) ?? "gpt-5.4-mini";
  const title = maybeString(params.title);

  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);
  const receipt = await readReceipt(ctx, companyId, issueId);
  const runId = findRunId(receipt);
  if (runId === null) throw new Error("No run_id in receipt; run forge-import first");

  const args = [
    "truth:synthesize-brief",
    `--run=${runId}`,
    `--model=${model}`,
    ...(title ? [`--title=${title}`] : []),
  ];
  const started = nowIso();
  const { stdout, stderr, exitCode } = await runArtisan(forgePath, args);
  const completed = nowIso();

  const stdoutKey = "forge.step-5-brief.stdout.txt";
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: stdoutKey,
    body: wrapTextInMarkdown("truth:synthesize-brief stdout/stderr", [
      "=== stdout ===",
      stdout,
      "",
      "=== stderr ===",
      stderr,
    ].join("\n")),
    title: "forge step 5 — synthesize brief (stdout)",
    changeSummary: `plugin-truth-extract: truth:synthesize-brief exit=${exitCode}`,
  });

  const parsed = exitCode === 0 ? parseSynthesizeBrief(stdout) : null;
  const step: ForgeSubprocessStep = {
    step: 5,
    command: "truth:synthesize-brief",
    args: {
      run: runId,
      model,
      ...(title ? { title } : {}),
      forge_head_sha_observed: observedHead,
    },
    started_at: started,
    completed_at: completed,
    exit_code: exitCode,
    stdout_doc_key: stdoutKey,
    parsed,
  };
  if (exitCode === 0 && parsed === null) step.parse_miss = true;
  receipt.steps.push(step);
  markArchivalComplete(receipt);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 5 synthesize-brief · exit=${exitCode}`,
  );

  return {
    brief_id:
      parsed && typeof parsed.brief_id === "number" ? parsed.brief_id : null,
    brief_payload_hash:
      parsed && typeof parsed.brief_payload_hash === "string"
        ? parsed.brief_payload_hash
        : null,
    exit_code: exitCode,
  };
}

// --- Action: forge-freeze-export -----------------------------------------

async function forgeFreezeExport(
  ctx: PluginContext,
  params: ForgeIssueRef & { formats?: unknown; dryRun?: unknown },
): Promise<{
  gate_verdict: string | null;
  export_count: number;
  exit_code: number;
}> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  const formats = Array.isArray(params.formats)
    ? (params.formats as unknown[]).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      )
    : [];
  const dryRun = params.dryRun === true;

  const forgePath = await resolveForgePath();
  const observedHead = await verifyForgePin(forgePath);
  const receipt = await readReceipt(ctx, companyId, issueId);
  const runId = findRunId(receipt);
  const briefId = findBriefId(receipt);
  if (runId === null) throw new Error("No run_id in receipt; run forge-import first");
  if (briefId === null)
    throw new Error("No brief_id in receipt; run forge-synthesize-brief first");

  const args = [
    "truth:freeze-export",
    `--run=${runId}`,
    `--brief=${briefId}`,
    ...formats.map((f) => `--format=${f}`),
    ...(dryRun ? ["--dry-run"] : []),
  ];
  const started = nowIso();
  const { stdout, stderr, exitCode } = await runArtisan(forgePath, args);
  const completed = nowIso();

  const stdoutKey = "forge.step-6-freeze.stdout.txt";
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: stdoutKey,
    body: wrapTextInMarkdown("truth:freeze-export stdout/stderr", [
      "=== stdout ===",
      stdout,
      "",
      "=== stderr ===",
      stderr,
    ].join("\n")),
    title: "forge step 6 — freeze export (stdout)",
    changeSummary: `plugin-truth-extract: truth:freeze-export exit=${exitCode}`,
  });

  const parsed = exitCode === 0 ? parseFreezeExport(stdout) : null;
  const step: ForgeSubprocessStep = {
    step: 6,
    command: "truth:freeze-export",
    args: {
      run: runId,
      brief: briefId,
      formats,
      ...(dryRun ? { dry_run: true } : {}),
      forge_head_sha_observed: observedHead,
    },
    started_at: started,
    completed_at: completed,
    exit_code: exitCode,
    stdout_doc_key: stdoutKey,
    parsed,
  };
  if (exitCode === 0 && parsed === null) step.parse_miss = true;
  receipt.steps.push(step);
  markArchivalComplete(receipt);
  await writeReceipt(
    ctx,
    companyId,
    issueId,
    receipt,
    `forge step 6 freeze-export · exit=${exitCode}`,
  );

  const gateVerdict =
    parsed && typeof parsed.gate_verdict === "string"
      ? parsed.gate_verdict
      : null;
  const exportCount =
    parsed && Array.isArray(parsed.exports) ? parsed.exports.length : 0;

  return { gate_verdict: gateVerdict, export_count: exportCount, exit_code: exitCode };
}

// --- Action: get-receipt & list-runs -------------------------------------

type RunSummary = {
  issueId: string;
  title: string;
  status: string;
  createdAt: string;
  archivalComplete: boolean;
  gateVerdict: string | null;
};

async function getReceipt(
  ctx: PluginContext,
  params: ForgeIssueRef,
): Promise<Receipt> {
  const companyId = requireString(params.companyId, "companyId");
  const issueId = requireString(params.issueId, "issueId");
  return readReceipt(ctx, companyId, issueId);
}

async function listRuns(
  ctx: PluginContext,
  params: { companyId?: unknown; limit?: unknown },
): Promise<RunSummary[]> {
  const companyId = requireString(params.companyId, "companyId");
  const limit = typeof params.limit === "number" ? params.limit : 25;

  // Identify runs by the presence of `proposal-forge.receipt.json`, not by
  // title. `createRun()` accepts an operator-supplied title, so any
  // title-based filter would drop custom-titled runs from the plugin's own
  // list. Over-fetch so we can still hit the requested limit after filtering
  // out unrelated issues.
  const allIssues = await ctx.issues.list({ companyId, limit: limit * 4 });

  const out: RunSummary[] = [];
  for (const issue of allIssues) {
    if (out.length >= limit) break;
    let receipt: Receipt;
    try {
      receipt = await readReceipt(ctx, companyId, issue.id);
    } catch {
      continue; // not one of ours, or has a malformed receipt
    }
    // Sanity-check the marker fields — a receipt on an unrelated issue
    // should be impossible, but refuse to misclassify if one appears.
    if (receipt.receipt_version !== RECEIPT_VERSION) continue;

    let gateVerdict: string | null = null;
    const freezeStep = [...receipt.steps]
      .reverse()
      .find(
        (s) =>
          "exit_code" in s &&
          s.command === "truth:freeze-export" &&
          s.parsed !== null,
      ) as ForgeSubprocessStep | undefined;
    if (
      freezeStep &&
      freezeStep.parsed &&
      typeof freezeStep.parsed.gate_verdict === "string"
    ) {
      gateVerdict = freezeStep.parsed.gate_verdict;
    }

    out.push({
      issueId: issue.id,
      title: issue.title,
      status: issue.status,
      createdAt: toIsoString(issue.createdAt),
      archivalComplete: receipt.archival_complete,
      gateVerdict,
    });
  }
  return out;
}

// --- Receipt helpers -----------------------------------------------------

function findRunId(receipt: Receipt): number | null {
  for (const s of receipt.steps) {
    if (
      "parsed" in s &&
      s.command === "truth:import-liberty-ledger" &&
      s.parsed &&
      typeof (s.parsed as Record<string, unknown>).run_id === "number"
    ) {
      return (s.parsed as { run_id: number }).run_id;
    }
  }
  return null;
}

function findBriefId(receipt: Receipt): number | null {
  for (const s of receipt.steps) {
    if (
      "parsed" in s &&
      s.command === "truth:synthesize-brief" &&
      s.parsed &&
      typeof (s.parsed as Record<string, unknown>).brief_id === "number"
    ) {
      return (s.parsed as { brief_id: number }).brief_id;
    }
  }
  return null;
}

// --- Plugin wiring -------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} setup complete (thin-binding v0.2)`);

    ctx.actions.register(ACTION_KEYS.createRun, async (p) =>
      createRun(ctx, p as CreateRunParams),
    );
    ctx.actions.register(ACTION_KEYS.forgeImport, async (p) =>
      forgeImport(ctx, p as ForgeIssueRef & { title?: unknown }),
    );
    ctx.actions.register(ACTION_KEYS.forgeBulkAcceptAtoms, async (p) =>
      forgeBulkAcceptAtoms(ctx, p as ForgeIssueRef),
    );
    ctx.actions.register(ACTION_KEYS.forgeAttestAtomReview, async (p) =>
      forgeAttestAtomReview(
        ctx,
        p as ForgeIssueRef & { operator?: unknown; note?: unknown },
      ),
    );
    ctx.actions.register(ACTION_KEYS.forgeSynthesizeClaims, async (p) =>
      forgeSynthesizeClaims(
        ctx,
        p as ForgeIssueRef & { mode?: unknown; model?: unknown },
      ),
    );
    ctx.actions.register(ACTION_KEYS.forgeAttestClaimReview, async (p) =>
      forgeAttestClaimReview(
        ctx,
        p as ForgeIssueRef & { operator?: unknown; note?: unknown },
      ),
    );
    ctx.actions.register(ACTION_KEYS.forgeSynthesizeBrief, async (p) =>
      forgeSynthesizeBrief(
        ctx,
        p as ForgeIssueRef & { title?: unknown; model?: unknown },
      ),
    );
    ctx.actions.register(ACTION_KEYS.forgeFreezeExport, async (p) =>
      forgeFreezeExport(
        ctx,
        p as ForgeIssueRef & { formats?: unknown; dryRun?: unknown },
      ),
    );
    ctx.actions.register(ACTION_KEYS.getReceipt, async (p) =>
      getReceipt(ctx, p as ForgeIssueRef),
    );
    ctx.actions.register(ACTION_KEYS.listRuns, async (p) =>
      listRuns(ctx, p as { companyId?: unknown; limit?: unknown }),
    );
  },

  async onHealth() {
    const envSet = !!process.env.PAPERCLIP_TRUTH_FORGE_PATH;
    return {
      status: envSet ? "ok" : "degraded",
      message: envSet
        ? "truth-extract thin-binding ready"
        : "PAPERCLIP_TRUTH_FORGE_PATH not set; forge actions will fail",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
