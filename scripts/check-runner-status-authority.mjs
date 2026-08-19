#!/usr/bin/env node
// Structural conformance gate for the status-authority corpus.
//
// Usage: pnpm check:runner-status-authority
//
// This validates the language-neutral fixture matrix before runtime
// implementations exist. Runtime suites consume the same fixture IDs and add
// database/transport setup without changing the expected semantics.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "packages", "paperclip-runner", "spec", "native-runner-contract.md");
const fixturePath = join(root, "packages", "paperclip-runner", "spec", "fixtures", "status-authority-sdk.json");
const spec = readFileSync(specPath, "utf8");
const corpus = JSON.parse(readFileSync(fixturePath, "utf8"));

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(`FAIL  ${name} — ${error.message}`);
  }
}

function section(source, heading) {
  const start = source.indexOf(heading);
  if (start === -1) throw new Error(`missing heading: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = source.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

function tableIds(source, prefix) {
  return [...source.matchAll(new RegExp(`^\\| (${prefix}-\\d+) \\|`, "gm"))].map((match) => match[1]);
}

function assertExactCoverage(label, definedIds, coverKey) {
  const covered = new Set(corpus.fixtures.flatMap((fixture) => fixture.covers[coverKey]));
  const missing = definedIds.filter((id) => !covered.has(id));
  const unknown = [...covered].filter((id) => !definedIds.includes(id));
  if (missing.length || unknown.length) {
    throw new Error([
      missing.length ? `missing ${missing.join(", ")}` : null,
      unknown.length ? `unknown ${unknown.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }
  return `${definedIds.length} ${label} rows covered`;
}

const decisionSection = section(spec, "### 18.3 Status authority and human-needed signaling");
const attentionSection = section(spec, "#### 18.3.7 Weak-agent and adversarial scenario check");
const terminalSection = section(spec, "### 18.5 Complete terminal conversion contract");
const statusAuthority = section(spec, "### 18.13 Status-authority conformance, migration, and rollback contract");

check("corpus header is versioned", () => {
  if (corpus.schema !== "paperclip.status-authority-conformance.v1") {
    throw new Error(`unexpected schema ${corpus.schema}`);
  }
  if (!Number.isInteger(corpus.corpusRevision) || corpus.corpusRevision < 1) {
    throw new Error("corpusRevision must be a positive integer");
  }
  if (typeof corpus.policyVersion !== "string" || corpus.policyVersion.length === 0) {
    throw new Error("policyVersion is required");
  }
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length < 35) {
    throw new Error(`fixture corpus looks truncated (${corpus.fixtures?.length ?? 0})`);
  }
  return `revision ${corpus.corpusRevision}, ${corpus.fixtures.length} fixtures`;
});

check("fixture IDs and required fields are valid", () => {
  const ids = new Set();
  const coverKeys = [
    "decisionRows",
    "terminalRows",
    "attentionRows",
    "livenessRows",
    "reconciliationRows",
    "compatibilityRows",
    "migrationRows",
  ];
  const requiredGiven = [
    "priorIssueStatus",
    "turnTerminalState",
    "runTerminalState",
    "reportedWorkDisposition",
    "nativeFinalization",
    "completionState",
    "trigger",
  ];
  const requiredExpected = [
    "runStatus",
    "statusAction",
    "reasonCode",
    "requiredEffects",
    "forbiddenEffects",
    "livePathKind",
    "preserveClaim",
    "nativeRecords",
    "decisionCount",
    "maxWakeCount",
    "maxNotificationCount",
  ];
  for (const fixture of corpus.fixtures) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.id)) throw new Error(`invalid fixture id ${fixture.id}`);
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    if (!["native", "legacy"].includes(fixture.mode)) throw new Error(`${fixture.id}: invalid mode`);
    if (!fixture.covers || coverKeys.some((key) => !Array.isArray(fixture.covers[key]))) {
      throw new Error(`${fixture.id}: incomplete covers object`);
    }
    if (!Array.isArray(fixture.tags)) throw new Error(`${fixture.id}: tags must be an array`);
    if (!fixture.given || requiredGiven.some((key) => !(key in fixture.given))) {
      throw new Error(`${fixture.id}: incomplete given facts`);
    }
    if (fixture.given.reviewGate !== undefined && !["completion", "mid_work"].includes(fixture.given.reviewGate)) {
      throw new Error(`${fixture.id}: invalid reviewGate`);
    }
    if (!fixture.expected || requiredExpected.some((key) => !(key in fixture.expected))) {
      throw new Error(`${fixture.id}: incomplete expected facts`);
    }
    if (!fixture.replay || !Number.isInteger(fixture.replay.attempts) || fixture.replay.attempts < 1) {
      throw new Error(`${fixture.id}: invalid replay contract`);
    }
  }
  return `${ids.size} unique IDs`;
});

check("every status-decision row has a fixture", () =>
  assertExactCoverage("decision", tableIds(decisionSection, "SD"), "decisionRows"));

check("every terminal-conversion row has a fixture", () =>
  assertExactCoverage("terminal", tableIds(terminalSection, "TC"), "terminalRows"));

check("every adversarial-attention row has a fixture", () =>
  assertExactCoverage("attention", tableIds(attentionSection, "ATT"), "attentionRows"));

for (const [label, heading, prefix, coverKey] of [
  ["atomic liveness", "#### 18.13.2 Atomic liveness fixtures", "LIVE", "livenessRows"],
  ["reconciliation", "#### 18.13.3 Deterministic replay and reconciliation fixtures", "REC", "reconciliationRows"],
  ["compatibility", "#### 18.13.4 Native, legacy, and existing-state compatibility", "COMP", "compatibilityRows"],
  ["migration", "#### 18.13.5 Rollout and migration sequence", "MIG", "migrationRows"],
]) {
  check(`every ${label} row has a fixture`, () =>
    assertExactCoverage(label, tableIds(section(spec, heading), prefix), coverKey));
}

check("all stable decision reason codes are exercised", () => {
  const enumBlock = spec.match(/`StatusDecisionReasonCode` is a stable protocol enum[\s\S]*?```text\n([\s\S]*?)```/);
  if (!enumBlock) throw new Error("could not locate StatusDecisionReasonCode enum");
  const defined = enumBlock[1].trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const exercised = new Set(corpus.fixtures.map((fixture) => fixture.expected.reasonCode).filter(Boolean));
  const missing = defined.filter((code) => !exercised.has(code));
  if (missing.length) throw new Error(`unexercised reason code(s): ${missing.join(", ")}`);
  return `${defined.length} reason codes exercised`;
});

check("required adversarial tags are all selectable", () => {
  const required = [
    "premature_done_claim",
    "incomplete_evidence",
    "required_review",
    "continuation",
    "partial_progress",
    "real_blocker",
    "excessive_human_request",
    "repeated_question",
    "false_blocker",
    "partial_evidence_before_failure",
    "finalization_failure",
    "cancellation_scope",
    "authorized_resume",
    "supersession",
    "native_legacy_distinction",
    "existing_issue_state",
    "atomic_liveness",
    "deterministic_replay",
    "reconciliation",
    "rollback",
  ];
  const tags = new Set(corpus.fixtures.flatMap((fixture) => fixture.tags));
  const missing = required.filter((tag) => !tags.has(tag));
  if (missing.length) throw new Error(`missing tag(s): ${missing.join(", ")}`);
  return `${required.length} required tags present`;
});

check("non-terminal status fixtures carry an atomic liveness path", () => {
  const acceptedEffects = {
    in_review: new Set(["bind_reviewer", "create_interaction"]),
    blocked: new Set(["bind_blocker"]),
    in_progress: new Set(["enqueue_continuation", "schedule_retry", "create_delegated_issue"]),
  };
  const violations = [];
  for (const fixture of corpus.fixtures) {
    const expected = fixture.expected;
    const allowed = acceptedEffects[expected.statusAction];
    if (!allowed) continue;
    if (expected.livePathKind === null || !expected.requiredEffects.some((effect) => allowed.has(effect))) {
      violations.push(fixture.id);
    }
  }
  if (violations.length) throw new Error(`missing atomic path/effect: ${violations.join(", ")}`);
  return "in_review, blocked, and in_progress paths validated";
});

check("duplicate attention creates no status decision or unbounded loop", () => {
  const duplicates = corpus.fixtures.filter((fixture) => fixture.expected.reasonCode === "attention_duplicate_suppressed");
  if (duplicates.length === 0) throw new Error("no duplicate-attention fixture");
  const unsafe = duplicates.filter((fixture) =>
    fixture.expected.decisionCount !== 0 ||
    fixture.expected.maxWakeCount !== 0 ||
    fixture.expected.maxNotificationCount !== 0 ||
    fixture.replay.maxSemanticDecisions !== 0 ||
    fixture.replay.maxDomainEffectsPerKey > 1);
  if (unsafe.length) throw new Error(`unsafe duplicate fixture(s): ${unsafe.map((fixture) => fixture.id).join(", ")}`);
  return `${duplicates.length} duplicate fixture(s) bounded at zero decisions/wakes/notifications`;
});

check("audit-only duplicate and stale fixtures retain exact durable targets", () => {
  const expected = new Map([
    ["duplicate-and-fresh-key-question", ["equivalent_attention_family", "link_canonical_request"]],
    ["stale-attention-response", ["response_after_supersession", "record_stale_response"]],
  ]);
  for (const [id, [completionState, effect]] of expected) {
    const fixture = corpus.fixtures.find((candidate) => candidate.id === id);
    if (!fixture) throw new Error(`missing ${id}`);
    if (
      fixture.mode !== "native"
      || fixture.given.completionState !== completionState
      || fixture.expected.runStatus !== "succeeded"
      || fixture.expected.statusAction !== "preserve"
      || fixture.expected.reasonCode !== "attention_duplicate_suppressed"
      || fixture.expected.decisionCount !== 0
      || fixture.expected.maxWakeCount !== 0
      || fixture.expected.maxNotificationCount !== 0
      || !fixture.expected.requiredEffects.includes(effect)
    ) {
      throw new Error(`${id} does not pin the zero-decision ${effect} outcome`);
    }
  }
  return "duplicate and stale targets are zero-decision audit outcomes";
});

check("completion-gating human judgment is explicit", () => {
  const fixture = corpus.fixtures.find((candidate) => candidate.id === "human-authority-required");
  if (!fixture) throw new Error("missing human-authority-required fixture");
  if (!fixture.covers.decisionRows.includes("SD-11") ||
      fixture.given.completionState !== "intentional_human_judgment" ||
      fixture.given.reviewGate !== "completion" ||
      fixture.expected.statusAction !== "in_review") {
    throw new Error("human-authority-required does not pin the SD-11 completion-review branch");
  }
  return "human-authority-required pins reviewGate=completion";
});

check("replay effects are at-most-once per semantic key", () => {
  const unsafe = corpus.fixtures.filter((fixture) =>
    fixture.replay.maxDomainEffectsPerKey !== 1 ||
    fixture.replay.maxSemanticDecisions > fixture.expected.decisionCount + 1);
  if (unsafe.length) throw new Error(`unsafe replay bounds: ${unsafe.map((fixture) => fixture.id).join(", ")}`);
  const replayed = corpus.fixtures.filter((fixture) => fixture.replay.attempts > 1);
  if (replayed.length < 30) throw new Error(`too few replayed fixtures (${replayed.length})`);
  return `${replayed.length} fixtures replayed with one effect per key`;
});

check("native and legacy expectations remain intentionally distinct", () => {
  const legacy = corpus.fixtures.filter((fixture) => fixture.mode === "legacy");
  const native = corpus.fixtures.filter((fixture) => fixture.mode === "native");
  if (!legacy.length || !native.length) throw new Error("both modes are required");
  const badLegacy = legacy.filter((fixture) =>
    fixture.expected.nativeRecords || fixture.expected.decisionCount !== 0 || fixture.expected.statusAction !== "legacy_finalizer");
  const badNative = native.filter((fixture) => fixture.expected.statusAction === "legacy_finalizer");
  if (badLegacy.length || badNative.length) {
    throw new Error(`mode leakage in: ${[...badLegacy, ...badNative].map((fixture) => fixture.id).join(", ")}`);
  }
  return `${native.length} native / ${legacy.length} legacy fixtures`;
});

check("rollback fixture forbids active-run mode conversion", () => {
  const rollback = corpus.fixtures.find((fixture) => fixture.covers.migrationRows.includes("MIG-08"));
  if (!rollback) throw new Error("missing MIG-08 fixture");
  if (!rollback.expected.requiredEffects.includes("fresh_flag_off_run_selects_legacy") ||
      !rollback.expected.requiredEffects.includes("finish_as_native") ||
      !rollback.expected.forbiddenEffects.includes("convert_active_run_to_legacy") ||
      !rollback.expected.forbiddenEffects.includes("persist_agent_kill_switch")) {
    throw new Error("MIG-08 does not prove global flag-off selection plus immutable active-run mode");
  }
  return rollback.id;
});

check("status-authority conformance markdown tables are rectangular", () => {
  const lines = statusAuthority.split("\n");
  let inFence = false;
  let expectedColumns = null;
  let tables = 0;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const isRow = line.trimStart().startsWith("|") && line.trimEnd().endsWith("|");
    if (!isRow) {
      expectedColumns = null;
      return;
    }
    const columns = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
    if (expectedColumns === null) {
      expectedColumns = columns;
      tables += 1;
    } else if (columns !== expectedColumns) {
      throw new Error(`ragged table at status-authority conformance offset line ${index + 1}: ${columns} vs ${expectedColumns}`);
    }
  });
  if (inFence) throw new Error("unbalanced code fence in section 18.13");
  return `${tables} tables`;
});

for (const line of checks) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${checks.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
