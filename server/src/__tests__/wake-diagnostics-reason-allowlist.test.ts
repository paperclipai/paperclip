import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static, DB-free guard against a recurring bug class: a literal `reason` written to
// `agentWakeupRequests` that is not in `ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS` renders as
// `"other"` in `GET /api/issues/:id/diagnostics/wakes`. Wake delivery still works, so the
// gap is invisible until someone reads the diagnostics endpoint and sees `"other"` instead
// of the real reason. The allow-list drifts every time a new wake site is added, so this
// test scans every `agentWakeupRequests` insert/update site and fails when it finds a
// reason the allow-list does not know about.

const SERVER_SRC_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ISSUES_ROUTES_PATH = path.join(SERVER_SRC_DIR, "routes/issues.ts");

// Identifiers observed as the value of `reason`/`wakeReason` at an `agentWakeupRequests`
// write site that are genuinely open-ended by design (caller-supplied at runtime), not
// missing allow-list entries. Verified by hand when added. If a new dynamic
// identifier shows up that isn't listed here, the test below fails loudly rather than
// silently skipping it, so any addition here must be a deliberate, reviewed decision.
const KNOWN_DYNAMIC_REASON_SOURCES = new Set([
  // scheduleBoundedRetryForRun's `opts.wakeReason` is exposed on the exported
  // `scheduleBoundedRetry` service method for external callers (server/src/services/heartbeat.ts).
  "wakeReason",
  // writeSkippedHeartbeatRequest(skipReason, ...) -- every call site passes a literal already
  // in the allow-list ("heartbeat.scheduling_suppressed" | "heartbeat.worktree_execution_cutoff" |
  // "heartbeat.timer.no_actionable_work").
  "skipReason",
  // issue.status === "todo" ? "issue_assignment_recovery" : "issue_continuation_needed" -- both
  // branches already in the allow-list.
  "recoveryReason",
  // getHeartbeatDailyCapBlock() only ever returns "heartbeat.daily_run_limit" or
  // "heartbeat.daily_cost_limit", both already in the allow-list.
  "dailyCapBlock.reason",
  // enqueueWake(input) in server/src/services/native-runtime/status-decision-committer.ts
  // is a file-local helper; every one of its six call sites passes a literal, and all four
  // distinct values are in the allow-list: "issue_status_changed", "monitor_due",
  // "issue_children_completed", "issue_blockers_resolved". Traced by hand when upstream's
  // native status-decision committer landed.
  "input.reason",
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function extractBalancedParens(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

function extractKnownReasons(): Set<string> {
  const text = fs.readFileSync(ISSUES_ROUTES_PATH, "utf8");
  const match = text.match(/const ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) {
    throw new Error("could not locate ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS in server/src/routes/issues.ts");
  }
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

function buildStringConstantMap(): Map<string, string> {
  const dirs = [
    SERVER_SRC_DIR,
    path.join(REPO_ROOT, "packages/shared/src"),
    path.join(REPO_ROOT, "packages/db/src"),
  ].filter((d) => fs.existsSync(d));
  const constMap = new Map<string, string>();
  const constRe = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*"([^"]+)"/g;
  for (const dir of dirs) {
    for (const file of walkTsFiles(dir)) {
      const text = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      constRe.lastIndex = 0;
      while ((m = constRe.exec(text))) {
        constMap.set(m[1], m[2]);
      }
    }
  }
  return constMap;
}

/**
 * Finds every `.insert(agentWakeupRequests)` / `.update(agentWakeupRequests)` call site
 * under server/src and resolves the `reason` field of its `.values(...)`/`.set(...)`
 * argument to a literal string where possible.
 */
function collectWakeupReasonLiterals(): { reason: string; files: string[] }[] {
  const constMap = buildStringConstantMap();
  const found = new Map<string, Set<string>>();
  const unresolved = new Map<string, Set<string>>();

  for (const file of walkTsFiles(SERVER_SRC_DIR)) {
    const text = fs.readFileSync(file, "utf8");
    const sinkRe = /\.(insert|update)\(agentWakeupRequests\)/g;
    let m: RegExpExecArray | null;
    while ((m = sinkRe.exec(text))) {
      const windowEnd = Math.min(text.length, m.index + 4000);
      const after = text.slice(m.index, windowEnd);
      const callMatch = after.match(/\.(set|values)\(/);
      if (!callMatch || callMatch.index === undefined) continue;
      const openIdx = m.index + callMatch.index + callMatch[0].length - 1;
      const block = extractBalancedParens(text, openIdx);
      const reasonMatch = block.match(/reason\s*:\s*("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/);
      if (!reasonMatch) continue;

      const relFile = path.relative(REPO_ROOT, file);
      if (reasonMatch[2]) {
        if (!found.has(reasonMatch[2])) found.set(reasonMatch[2], new Set());
        found.get(reasonMatch[2])!.add(relFile);
        continue;
      }

      const identifier = reasonMatch[1];
      if (constMap.has(identifier)) {
        const literal = constMap.get(identifier)!;
        if (!found.has(literal)) found.set(literal, new Set());
        found.get(literal)!.add(relFile);
      } else if (KNOWN_DYNAMIC_REASON_SOURCES.has(identifier)) {
        // Deliberately excluded -- see KNOWN_DYNAMIC_REASON_SOURCES above.
        continue;
      } else {
        if (!unresolved.has(identifier)) unresolved.set(identifier, new Set());
        unresolved.get(identifier)!.add(relFile);
      }
    }
  }

  if (unresolved.size > 0) {
    const details = [...unresolved.entries()]
      .map(([id, files]) => `${id} (${[...files].join(", ")})`)
      .join("\n");
    throw new Error(
      `Found reason source(s) at agentWakeupRequests write sites that this scan can't resolve to a literal:\n${details}\n\n` +
        `Either it resolves to a value already covered by KNOWN_DYNAMIC_REASON_SOURCES (add it there with a comment ` +
        `explaining why it's safe), or it's a new literal that needs a manual trace and an entry in ` +
        `ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.`,
    );
  }

  return [...found.entries()].map(([reason, files]) => ({ reason, files: [...files] }));
}

describe("agent_wakeup_requests reason allow-list completeness", () => {
  it("keeps ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS in sync with every reason literal written to agentWakeupRequests", () => {
    const knownReasons = extractKnownReasons();
    const literals = collectWakeupReasonLiterals();
    const missing = literals.filter((entry) => !knownReasons.has(entry.reason));

    expect(
      missing,
      missing.length === 0
        ? undefined
        : `Reason(s) written to agentWakeupRequests but missing from ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS ` +
            `in server/src/routes/issues.ts (they will render as "other" in /diagnostics/wakes):\n` +
            missing.map((entry) => `  "${entry.reason}" (${entry.files.join(", ")})`).join("\n"),
    ).toEqual([]);
  });
});
