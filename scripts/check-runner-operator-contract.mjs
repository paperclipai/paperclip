#!/usr/bin/env node
// Structural consistency check for the operator/reviewer contract
// (spec section 18.12) against the approved operator UX reference.
//
// Usage: pnpm check:runner-operator-contract
//
// This is a spec-level gate, not a runtime test. It proves that the operator
// presentation contract, the arbitration contract it renders, and the approved
// UX document stay in agreement.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const specDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "paperclip-runner", "spec");
const spec = readFileSync(join(specDir, "native-runner-contract.md"), "utf8");
const ux = readFileSync(join(specDir, "paperclip-runner-status-attention-ux.md"), "utf8");

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

const operatorContract = section(spec, "### 18.12 Operator and reviewer read models and presentation contract");

// 1. Reason-code enum totality across spec, UX copy table, and operator contract gates.
check("reason-code enum has UX copy for every value", () => {
  const enumBlock = spec.match(/`StatusDecisionReasonCode` is a stable protocol enum[\s\S]*?```text\n([\s\S]*?)```/);
  if (!enumBlock) throw new Error("could not locate the reason-code enum block");
  const codes = enumBlock[1].trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (codes.length < 20) throw new Error(`enum looks truncated (${codes.length} codes)`);
  const copyTable = section(ux, "## 4. Reason-code copy table (complete v1 enum)");
  const missing = codes.filter((code) => {
    if (copyTable.includes(code)) return false;
    // The UX table folds the two cancellation scopes into one row.
    const folded = code.replace(/^cancellation_(turn|run)_only$/, "cancellation_turn_only / _run_only");
    return !copyTable.includes(folded) && !copyTable.includes(code.replace("cancellation_", "_"));
  });
  if (missing.length) throw new Error(`no operator copy for: ${missing.join(", ")}`);
  return `${codes.length} codes covered`;
});

// 2. Every operator field the UX document requires has a read-model field.
check("attention card required fields exist in the read model", () => {
  const attention = section(spec, "#### 18.12.5 Attention read model");
  const required = {
    owner: /\bresolver\??:/,
    "resolver route": /\broute\??:\s*"context"/,
    "derived authority": /minimum:\s*CanonicalAttentionRequest\["minimumAuthority"\]/,
    "requested authority": /requested:\s*CanonicalAttentionRequest\["minimumAuthority"\]/,
    "authority correction": /corrected:\s*boolean/,
    "effective scope": /effective:\s*"current_turn"/,
    "scope narrowing": /narrowed:\s*boolean/,
    attempts: /attempts:\s*\{/,
    "attempt history": /history:\s*Array<\{/,
    expiry: /expiry:\s*\{[^}]*expiresAt/,
    "deduplication state": /duplicates:\s*\{[^}]*suppressedCount/,
    "inline response eligibility": /canRespondInline:\s*boolean/,
    "continuation action": /resumeBinding:/,
    "delegated issue": /delegatedIssue:/,
    supersession: /supersededByRequestId:/,
  };
  const missing = Object.entries(required)
    .filter(([, pattern]) => !pattern.test(attention))
    .map(([label]) => label);
  if (missing.length) throw new Error(`missing field(s) for: ${missing.join(", ")}`);
  return `${Object.keys(required).length} required fields present`;
});

check("decision card required fields exist in the read model", () => {
  const decision = section(spec, "#### 18.12.4 Status decision and finalization read models");
  const required = {
    "four outcome layers": /outcome:\s*NativeOutcomeLayers/,
    "decision verb inputs": /transitionApplied:\s*boolean/,
    "reason code": /reasonCode:\s*StatusDecisionReasonCode/,
    "criterion assessments": /criterionAssessments:\s*Array<\{/,
    "evidence gaps": /missingRequirements:\s*string\[\]/,
    "pending governed actions": /pendingGovernedActions:\s*Array<\{/,
    "live paths": /livePaths:\s*LivePathView\[\]/,
    "live path integrity": /livePathIntegrity:/,
    "side effects": /sideEffects:\s*Array<\{/,
    supersession: /supersededByDecisionId:/,
    "audit footer": /audit:\s*\{/,
    "finalization phase": /phase:\s*\n?\s*\|?\s*"observed"/,
    "retry position": /retry:\s*\{[^}]*maxAttempts/,
    "recovery owner": /recoveryOwner:/,
    "status unchanged marker": /issueStatusUnchanged:\s*true/,
  };
  const missing = Object.entries(required)
    .filter(([, pattern]) => !pattern.test(decision))
    .map(([label]) => label);
  if (missing.length) throw new Error(`missing field(s) for: ${missing.join(", ")}`);
  return `${Object.keys(required).length} required fields present`;
});

// 3. Coverage matrix references only gates that are actually defined.
check("coverage matrix gates are all defined", () => {
  const matrix = section(spec, "#### 18.12.11 Requirement coverage matrix");
  const gatesSection = section(spec, "#### 18.12.13 Operator contract verification gates");
  const referenced = new Set([...matrix.matchAll(/OPX-F\d+/g)].map((m) => m[0]));
  const defined = new Set([...gatesSection.matchAll(/\|\s*(OPX-F\d+)\s*—/g)].map((m) => m[1]));
  if (referenced.size === 0) throw new Error("coverage matrix references no gates");
  const undefinedGates = [...referenced].filter((gate) => !defined.has(gate));
  if (undefinedGates.length) throw new Error(`undefined gate(s): ${undefinedGates.join(", ")}`);
  const unusedGates = [...defined].filter((gate) => !referenced.has(gate));
  if (unusedGates.length > 1) throw new Error(`gate(s) not reached by any matrix row: ${unusedGates.join(", ")}`);
  return `${defined.size} gates, ${referenced.size} referenced`;
});

// 4. Every presentation invariant is enforced somewhere, not just declared.
check("every OPX invariant is referenced outside its definition", () => {
  const invariants = section(spec, "#### 18.12.1 Operator presentation invariants");
  const defined = [...invariants.matchAll(/\|\s*(OPX-\d+)\s*\|/g)].map((m) => m[1]);
  if (defined.length !== 10) throw new Error(`expected 10 invariants, found ${defined.length}`);
  const body = operatorContract.replace(invariants, "");
  const orphans = defined.filter((id) => !new RegExp(`${id}\\b`).test(body));
  if (orphans.length) throw new Error(`declared but never enforced: ${orphans.join(", ")}`);
  return `${defined.length} invariants enforced`;
});

// 5. Every UX-document flow reaches a degraded/error rendering rule or a gate.
check("UX flows A-E are all covered by operator contract gates", () => {
  const gates = section(spec, "#### 18.12.13 Operator contract verification gates");
  const flowSubjects = {
    "A completion disagreement": /disagreement/i,
    "B human attention": /attention completeness/i,
    "C agent routing": /route affordances/i,
    "D duplicate suppression": /duplicate suppression/i,
    "E finalization error": /error truthfulness/i,
  };
  const missing = Object.entries(flowSubjects)
    .filter(([, pattern]) => !pattern.test(gates))
    .map(([label]) => label);
  if (missing.length) throw new Error(`no gate covers flow(s): ${missing.join(", ")}`);
  return "5 flows covered";
});

// 6. Read routes named in 18.11 and 18.12 agree.
check("read routes agree between 18.11 and 18.12", () => {
  const changeMap = section(spec, "### 18.11 API, shared-contract, UI, and implementation change map");
  const routes = section(spec, "#### 18.12.7 Read routes, authorization, and redaction");
  const required = [
    "/status-decisions",
    "/completion-contracts",
    "/finalization",
    "/attention-requests",
  ];
  const missing = required.filter((route) => !changeMap.includes(route) || !routes.includes(route));
  if (missing.length) throw new Error(`route(s) not present in both sections: ${missing.join(", ")}`);
  return `${required.length} routes aligned`;
});

// 7. Persistence prerequisites cover every table the read models select from.
check("attention read model has backing persistence", () => {
  const persistence = section(spec, "#### 18.12.2 Persistence prerequisites for the operator read model");
  const tables = ["attention_requests", "attention_request_attempts", "attention_budgets"];
  // Match the DDL declaration line exactly so a renamed table is a failure, not
  // a substring hit on a longer name.
  const missing = tables.filter((table) => !new RegExp(`^${table}\\s*$`, "m").test(persistence));
  if (missing.length) throw new Error(`missing table definition(s): ${missing.join(", ")}`);
  if (!persistence.includes("(company_id, issue_id, state, selected_route)")) {
    throw new Error("board-summary index is not specified");
  }
  return `${tables.length} tables + summary index`;
});

// 8. Copy law: the banned composed strings appear only as prohibitions.
check("banned claim strings appear only in prohibitions", () => {
  const banned = /agent (succeeded|failed|completed)/gi;
  for (const [label, source] of [["spec 18.12", operatorContract], ["ux doc", ux]]) {
    for (const match of source.matchAll(banned)) {
      const context = source.slice(Math.max(0, match.index - 160), match.index + 60);
      const prohibited = /never|banned|not\b|nowhere|zero matches|anti-copy|prohibit|forbid|\blie\b/i.test(context);
      if (!prohibited) throw new Error(`${label} uses "${match[0]}" outside a prohibition`);
    }
  }
  return "no affirmative uses";
});

// 9. Markdown tables in the new section are rectangular.
check("18.12 markdown tables are well formed", () => {
  const lines = operatorContract.split("\n");
  let inFence = false;
  let expected = null;
  let tables = 0;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const isRow = line.trimStart().startsWith("|") && line.trimEnd().endsWith("|");
    if (!isRow) {
      expected = null;
      return;
    }
    const columns = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
    if (expected === null) {
      expected = columns;
      tables += 1;
    } else if (columns !== expected) {
      throw new Error(`ragged table row at section offset line ${index + 1}: ${columns} columns, expected ${expected}`);
    }
  });
  if (inFence) throw new Error("unbalanced code fence in section 18.12");
  return `${tables} tables`;
});

// 10. Every degraded state names what must not be rendered.
check("degraded-state table forbids a manufactured state per row", () => {
  const degraded = section(spec, "#### 18.12.12 Degraded, legacy, and error states");
  const rows = degraded
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.startsWith("| Condition"));
  if (rows.length < 12) throw new Error(`expected at least 12 degraded-state rows, found ${rows.length}`);
  const emptyForbid = rows.filter((row) => {
    const cells = row.trim().slice(1, -1).split(/(?<!\\)\|/);
    return cells.length !== 3 || cells[2].trim().length === 0;
  });
  if (emptyForbid.length) throw new Error(`${emptyForbid.length} row(s) have no "must not" clause`);
  return `${rows.length} rows`;
});

for (const line of checks) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${checks.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
