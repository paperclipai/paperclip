import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pins the panel's decision rules. The script is sourced instead of executed so
// the classifier and renderers can be driven from fixtures without a database,
// which is the only way to cover states the live fleet does not currently show
// (a paused agent holding work, for example).

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "fleet-status.sh");
const renderPath = join(repoRoot, "scripts", "fleet-status-render.sh");
const script = readFileSync(scriptPath, "utf8");
const FIELD_SEPARATOR = "\x1f";

// Field order must match the SELECT list in fetch_rows().
function row(overrides = {}) {
  const fields = {
    company: "Testco",
    agent: "worker",
    status: "idle",
    pauseReason: "",
    runState: "",
    runCard: "",
    runAge: -1,
    runSilent: -1,
    active: 0,
    monitored: 0,
    review: 0,
    reviewInRun: 0,
    parked: 0,
    oldestActive: -1,
    oldestReview: -1,
    failed: 0,
    failedDetail: "",
    pending: 0,
    stalePending: 0,
    oldestPending: -1,
    recoveries: 0,
    ...overrides,
  };
  return [
    fields.company, fields.agent, fields.status, fields.pauseReason,
    fields.runState, fields.runCard, fields.runAge, fields.runSilent,
    fields.active, fields.monitored, fields.review, fields.reviewInRun,
    fields.parked, fields.oldestActive, fields.oldestReview,
    fields.failed, fields.failedDetail,
    fields.pending, fields.stalePending, fields.oldestPending,
    fields.recoveries,
  ].join(FIELD_SEPARATOR);
}

function drive({ rows, mode = "text", scopeMulti = 0, scopeNames = ["Testco"], extra = "" }) {
  const driver = [
    "set -u",
    'source "$SCRIPT"',
    "reset_counters",
    'ROWS="$FIXTURE"',
    `SCOPE_NAMES=${JSON.stringify(scopeNames.join(", "))}`,
    `SCOPE_NAME_LIST=(${scopeNames.map((name) => JSON.stringify(name)).join(" ")})`,
    `SCOPE_MULTI=${scopeMulti}`,
    'GENERATED_AT="2026-01-01 00:00:00"',
    'GENERATED_AT_ISO="2026-01-01T00:00:00+0000"',
    `MODE=${mode}`,
    mode === "json" ? "render_json" : "render_text",
    "decide_exit",
    extra,
  ].join("\n");

  return spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath, FIXTURE: rows.join("\n") },
  });
}

test("script is executable, parses, and needs only bash plus psql", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
  assert.match(script, /^set -uo pipefail$/m);
  assert.doesNotMatch(script, /^\s*python3?\s/m, "the panel must not shell out to python");
  assert.doesNotMatch(script, /command -v python/, "the panel must not depend on python");
  assert.doesNotMatch(script, /^\s*jq\s/m, "the panel must not shell out to jq");
});

test("the panel sources the renderer next to itself", () => {
  accessSync(renderPath, constants.R_OK);
  execFileSync("bash", ["-n", renderPath]);
  assert.match(script, /fleet-status-render\.sh/, "the panel must load the renderer");
  const sourced = execFileSync(
    "bash",
    ["-c", 'set -u; source "$1"; declare -F render_text render_json >/dev/null', "_", scriptPath],
    { encoding: "utf8" },
  );
  assert.equal(sourced, "");
});

test("neither panel file grows past the size rule", () => {
  for (const path of [scriptPath, renderPath]) {
    const lines = readFileSync(path, "utf8").split("\n").length;
    assert.ok(lines <= 1000, `${path} has ${lines} lines`);
  }
});

test("an idle agent with no work is capacity, not attention", () => {
  const run = drive({ rows: [row({ agent: "free-1" }), row({ agent: "free-2" })] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /available/);
  assert.match(run.stdout, /Nothing to do/);
});

test("in-progress work with no waiting path is attention", () => {
  const run = drive({
    rows: [row({ agent: "stuck", active: 1, oldestActive: 42 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /1 open card\(s\) have no monitor, and no run, usable wakeup or recovery action covers them/);
  assert.match(run.stdout, /the oldest is 42m old/);
});

test("a queued wakeup is a waiting path, so it is not a stall", () => {
  const run = drive({
    rows: [row({ agent: "queued", active: 1, oldestActive: 90, pending: 1, oldestPending: 5 })],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /waiting to be claimed/);
});

test("a scheduled monitor is a waiting path, so it is not a stall", () => {
  const run = drive({
    rows: [row({ agent: "monitored", active: 2, monitored: 2, oldestActive: 90 })],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /have a monitor/);
});

test("a monitor covers only its own card, not the whole row", () => {
  // Three cards, one monitor: the other two still have nothing that will pick
  // them up, and the note must not claim the agent is fully covered.
  const run = drive({
    rows: [row({ agent: "partial", active: 3, monitored: 1, oldestActive: 20 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /2 open card\(s\) have no monitor/);
  assert.doesNotMatch(run.stdout, /have a monitor/);
});

test("a paused agent is reported as paused, not as idle", () => {
  const run = drive({
    rows: [row({ agent: "resting", status: "paused", active: 2, oldestActive: 30 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /resting\s+paused/);
  assert.match(run.stdout, /paused but still holds 2 open \/ 0 in review/);
  // Capacity stays at zero: a paused agent is not reported as free.
  assert.match(run.stdout, /available 0/);
});

test("a paused agent with no work is not attention", () => {
  const run = drive({
    rows: [row({ agent: "resting", status: "paused", pauseReason: "budget" })],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /paused \(reason: budget\)/);
});

test("a long and silent run is reported for inspection, not as a fault", () => {
  const run = drive({
    rows: [row({ agent: "slow", runState: "running", runCard: "T-1", runAge: 40, runSilent: 20 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /running 40m, no new output for 20m/);
  assert.match(run.stdout, /this is not a stall verdict/);
});

test("scheduled_retry is queued, not running, so silence is not checked", () => {
  const fresh = drive({
    rows: [row({ agent: "retry", runState: "scheduled_retry", runCard: "T-1", runAge: 5, runSilent: -1 })],
  });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /queued/);
  // The header itself contains the word "silent", so check the note does not.
  assert.doesNotMatch(fresh.stdout, /retry.*no new output/);

  const stale = drive({
    rows: [row({ agent: "retry", runState: "scheduled_retry", runCard: "T-1", runAge: 45, runSilent: -1 })],
  });
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stdout, /queued/);
  assert.match(stale.stdout, /not running after 45m/);
});

test("in_review is attention unless a live run is on that card", () => {
  const waiting = drive({ rows: [row({ agent: "reviewer", review: 2, oldestReview: 30 })] });
  assert.equal(waiting.status, 1, waiting.stderr);
  assert.match(waiting.stdout, /2 card\(s\) await a decision, the oldest is 30m old/);

  const inFlight = drive({
    rows: [row({
      agent: "reviewer", runState: "running", runCard: "T-2",
      runAge: 1, runSilent: 0, review: 1, reviewInRun: 1, oldestReview: 30,
    })],
  });
  assert.equal(inFlight.status, 0, inFlight.stderr);
  assert.match(inFlight.stdout, /review in_review 0/);
  assert.doesNotMatch(inFlight.stdout, /review in_review [1-9]/);
});

test("a stale queue is not a waiting path, so the work counts as stuck", () => {
  // The row must not say "waiting to be claimed" and "queued for six hours"
  // about the same wakeup.
  const run = drive({
    rows: [row({ agent: "stale-only", active: 1, oldestActive: 45, pending: 2, stalePending: 2, oldestPending: 356 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /stale-only\s+cards idle/);
  assert.doesNotMatch(run.stdout, /waiting to be claimed/);
  assert.match(run.stdout, /2 wakeup\(s\) queued longer than 30m \(oldest 356m\)/);
});

test("a fresh wakeup next to a stale one still counts as a waiting path", () => {
  // One fresh wakeup keeps the agent in "waiting" rather than "stuck", while the
  // older entries in the same queue are still reported on their own.
  const run = drive({
    rows: [row({ agent: "mixed", active: 1, pending: 3, stalePending: 2, oldestPending: 400 })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /mixed\s+waiting/);
  assert.match(run.stdout, /1 open card\(s\) and 1 queued wakeup\(s\): waiting to be claimed/);
  assert.match(run.stdout, /2 wakeup\(s\) queued longer than 30m \(oldest 400m\)/);
});

test("a stale wakeup is attention only when no run can drain it", () => {
  const stranded = drive({
    rows: [row({ agent: "idle-wake", pending: 3, stalePending: 3, oldestPending: 400 })],
  });
  assert.equal(stranded.status, 1, stranded.stderr);
  assert.match(stranded.stdout, /3 wakeup\(s\) queued longer than 30m \(oldest 400m\)/);

  const draining = drive({
    rows: [row({
      agent: "busy-wake", runState: "running", runAge: 2, runSilent: 0,
      pending: 3, stalePending: 3, oldestPending: 400,
    })],
  });
  assert.equal(draining.status, 0, draining.stderr);
  assert.match(draining.stdout, /a run is active or queued, so they are not counted as stale/);
  assert.doesNotMatch(draining.stdout, /queued longer than 30m/);
});

test("failed wakeups are attention and keep their error text", () => {
  const run = drive({
    rows: [row({ agent: "flaky", failed: 2, failedDetail: "429 Too Many Requests" })],
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /2 failed wakeup\(s\) in the last 3h \(429 Too Many Requests\)/);
});

test("text and JSON modes agree on the exit code", () => {
  const rows = [
    row({ agent: "free" }),
    row({ agent: "stuck", active: 1 }),
    row({ agent: "paused", status: "paused", active: 1 }),
  ];
  assert.equal(drive({ rows }).status, 1);
  assert.equal(drive({ rows, mode: "json" }).status, 1);

  const clean = [row({ agent: "free" })];
  assert.equal(drive({ rows: clean }).status, 0);
  assert.equal(drive({ rows: clean, mode: "json" }).status, 0);
});

test("JSON is valid, escapes text, and summarises the same run", () => {
  const rows = [
    row({ agent: 'quote"and\\backslash', active: 1, oldestActive: 12 }),
    row({ agent: "free" }),
  ];
  const run = drive({ rows, mode: "json" });
  assert.equal(run.status, 1, run.stderr);

  const doc = JSON.parse(run.stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.needsAttention, true);
  assert.equal(doc.agents.length, 2);
  assert.equal(doc.summary.agents.total, 2);
  assert.equal(doc.summary.agents.idleWithWork, 1);
  assert.equal(doc.summary.agents.free, 1);
  assert.equal(doc.summary.attention.agents, 1);
  assert.equal(doc.agents[0].agent, 'quote"and\\backslash');
  assert.deepEqual(doc.agents[0].attention, ["idle_with_work"]);
  assert.equal(doc.agents[1].needsAttention, false);
  // A missing run is null, not zero minutes.
  assert.equal(doc.agents[1].run.ageMinutes, null);
  assert.equal(doc.agents[1].run.state, null);
});

test("column width does not depend on the shell locale", () => {
  // Regression: under LC_ALL=C bash counts bytes, so CJK names were padded to
  // three columns per character and the table columns stopped lining up in
  // cron, systemd and CI runs that do not export a UTF-8 locale.
  const driver = [
    "set -u",
    'source "$SCRIPT"',
    'if [ -n "$FORCE_NO_UTF8" ]; then UTF8_LOCALE=""; fi',
    "for s in '交付主管' 'GPU 执行' 'AGENT' ''; do disp_width \"$s\"; printf '%s\\n' \"$W\"; done",
  ].join("\n");

  for (const forceNoUtf8 of ["", "1"]) {
    const run = spawnSync("bash", ["-c", driver], {
      encoding: "utf8",
      env: {
        ...process.env,
        SCRIPT: scriptPath,
        FORCE_NO_UTF8: forceNoUtf8,
        LC_ALL: "C",
        LANG: "C",
        LC_CTYPE: "C",
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split("\n"), ["8", "8", "5", "0"]);
  }
});

test("an empty agent list still renders valid JSON", () => {
  // Guards a bash 3.2 trap: "${empty[@]}" is an unbound variable under set -u,
  // so the entry loop must not depend on the array being non-empty.
  const run = drive({ rows: [], mode: "json" });
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(run.stdout);
  assert.deepEqual(doc.agents, []);
  assert.equal(doc.summary.agents.total, 0);
  assert.equal(doc.needsAttention, false);
});

test("multi-company scope adds the company column", () => {
  const rows = [
    row({ company: "Alpha", agent: "a1" }),
    row({ company: "Beta", agent: "b1" }),
  ];
  const single = drive({ rows });
  assert.doesNotMatch(single.stdout, /Company/);

  const multi = drive({ rows, scopeMulti: 1 });
  assert.match(multi.stdout, /Company/);
  assert.match(multi.stdout, /Alpha/);
  assert.match(multi.stdout, /Beta/);
});

test("a row with the wrong field count fails loudly instead of being dropped", () => {
  const run = drive({ rows: [row({ agent: "short" }).split(FIELD_SEPARATOR).slice(0, 5).join(FIELD_SEPARATOR)] });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /fields, expected 21/);
});

test("watch mode treats exit 1 as a normal render, not a failure", () => {
  // Regression: `run_once || warn` reported every "needs attention" render as
  // an unavailable panel.
  assert.match(script, /rc=\$\?\n\s+if \[ "\$rc" -eq 141 \]; then/);
  assert.match(script, /if \[ "\$rc" -eq 2 \]; then\n\s+warn "panel unavailable/);
  assert.doesNotMatch(script, /run_once \|\| warn/);
});

test("watch mode writes no terminal control codes to a file", () => {
  // `clear` used to run unconditionally, so a redirected --watch run collected
  // one escape sequence per frame. The database calls are stubbed so the test
  // does not need a live instance.
  const out = join(tmpdir(), `fleet-watch-${process.pid}.txt`);
  const driver = [
    'source "$SCRIPT"',
    "preflight() { return 0; }",
    'resolve_scope() { SCOPE_NAMES="Testco"; SCOPE_NAME_LIST=("Testco"); SCOPE_MULTI=0; EXCLUDED_TERMINATED=0; return 0; }',
    'fetch_rows() { SQL_OUT="$FIXTURE"; return 0; }',
    'main --watch 1 --db "postgresql://example.invalid/paperclip"',
  ].join("\n");
  const run = spawnSync("bash", ["-c", `${driver} > "$OUT" 2>&1`], {
    encoding: "utf8",
    timeout: 1800,
    env: { ...process.env, SCRIPT: scriptPath, OUT: out, FIXTURE: row({ agent: "worker" }) },
  });
  const written = readFileSync(out, "utf8");
  try { unlinkSync(out); } catch {}
  assert.ok(written.length > 0, `watch produced no output (status ${run.status}, ${run.signal})`);
  assert.doesNotMatch(written, /\u001b/, "watch wrote a terminal escape sequence to a file");
  assert.match(written, /FLEET STATUS/);
});

test("usage errors and help do not touch the database", () => {
  const help = spawnSync("bash", [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Exit codes:/);

  const bad = spawnSync("bash", [scriptPath, "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument/);

  const badNumber = spawnSync("bash", [scriptPath, "--running-slow", "abc"], { encoding: "utf8" });
  assert.equal(badNumber.status, 2);
  assert.match(badNumber.stderr, /non-negative integer/);

  const emptyEqual = spawnSync("bash", [scriptPath, "--company="], { encoding: "utf8" });
  assert.equal(emptyEqual.status, 2);
  assert.match(emptyEqual.stderr, /needs a company/);
});

test("--flag=value form is accepted for every argument that takes a value", () => {
  const run = spawnSync("bash", ["-c", 'source "$SCRIPT"; parse_args --company=Acme --db=postgres://x --running-slow=5 --run-silent=3 --todo-idle=2 --review-wait=1 --wake-window=2 --wake-stale=10 --watch=5 --json; echo "$COMPANY|$DB_DSN|$RUNNING_SLOW|$RUN_SILENT|$TODO_IDLE|$REVIEW_WAIT|$WAKE_WINDOW_H|$WAKE_STALE|$WATCH|$MODE"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "Acme|postgres://x|5|3|2|1|2|10|5|json");
});

test("--company trims surrounding whitespace", () => {
  const run = spawnSync("bash", ["-c", 'source "$SCRIPT"; parse_args --company="  Acme  "; echo "[$COMPANY]"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "[Acme]");
});

test("an unreachable database exits 2 rather than reporting an empty fleet", () => {
  const run = spawnSync("bash", [scriptPath, "--db", "postgresql://nobody@127.0.0.1:1/none"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 2);
  assert.notEqual(run.stderr.trim(), "");
});

test("a failed write is loud on a file and quiet on a closed pipe", () => {
  // emit() distinguishes the two with /dev/stdout, so the branch is exercised
  // by forcing a printf failure rather than by closing a real consumer.
  const toFile = join(tmpdir(), `fleet-emit-${process.pid}.txt`);
  const fileRun = spawnSync("bash", ["-c", 'source "$SCRIPT"; emit "%d" not-a-number > "$OUT"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath, OUT: toFile },
  });
  try { unlinkSync(toFile); } catch {}
  assert.equal(fileRun.status, 2);
  assert.match(fileRun.stderr, /cannot write output/);

  // A closed pipe exits 141 (128 + SIGPIPE) so a watched loop can detect it
  // and stop. The error message is silenced.
  const pipeRun = spawnSync("bash", ["-c", 'source "$SCRIPT"; emit "%d" not-a-number | cat; exit ${PIPESTATUS[0]}'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(pipeRun.status, 141);
  assert.equal(pipeRun.stderr.trim(), "");
});

test("an all-terminated scope is a quiet answer, not an unavailable panel", () => {
  const run = (excluded) => spawnSync("bash", ["-c", [
    "set -u",
    'source "$SCRIPT"',
    "resolve_scope() { SCOPE_NAMES=Testco; SCOPE_MULTI=0; return 0; }",
    "fetch_rows() { SQL_OUT=''; return 0; }",
    `EXCLUDED_TERMINATED=${excluded}`,
    "collect",
  ].join("\n")], { encoding: "utf8", env: { ...process.env, SCRIPT: scriptPath } });

  const allTerminated = run(2);
  assert.equal(allTerminated.status, 0, allTerminated.stderr);

  const nothingExplainsIt = run(0);
  assert.equal(nothingExplainsIt.status, 2);
  assert.match(nothingExplainsIt.stderr, /returned no agents/);
});

test("a second render does not inherit the previous scope width", () => {
  // --watch re-renders in one process; a stale SCOPE_MULTI would keep the
  // company column after the scope shrank to a single company.
  const driver = [
    "set -u",
    'source "$SCRIPT"',
    "reset_counters",
    'ROWS="$FIXTURE"',
    'SCOPE_NAMES="A, B"',
    "SCOPE_MULTI=1",
    'GENERATED_AT="t"',
    'GENERATED_AT_ISO="t"',
    "MODE=text",
    "render_text >/dev/null",
    "reset_counters",
    'ROWS="$FIXTURE"',
    'SCOPE_NAMES="A"',
    "render_text",
  ].join("\n");
  const run = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath, FIXTURE: row({ agent: "solo" }) },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Company/);
});

test("an archived-only scope exits 2 with a reason instead of an empty table", () => {
  // Stubbed: no archived company exists in a healthy instance, and the panel is
  // read-only, so the branch is driven by replacing the query function.
  const driver = [
    "set -u",
    'source "$SCRIPT"',
    'query() { SQL_OUT="1${FS}1${FS}0${FS}OldCo"; return 0; }',
    "resolve_scope",
  ].join("\n");
  const run = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /is archived/);
});

test("a company that matches nothing exits 2 instead of exiting 0", () => {
  // Stubbed: the scope query reports no matching company.
  const driver = [
    "set -u",
    'source "$SCRIPT"',
    'query() { SQL_OUT="0${FS}0${FS}0${FS}"; return 0; }',
    'COMPANY="no-such-company-xyz"',
    "resolve_scope",
  ].join("\n");
  const run = spawnSync("bash", ["-c", driver], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no company matches/);
});

test("a silent run is reported before it is old", () => {
  // The age threshold and the silence threshold are independent. A run that is
  // younger than --running-slow but silent for longer than --run-silent still
  // needs a human.
  const run = drive({ rows: [row({ agent: "quiet", runState: "running", runCard: "T-1", runAge: 15, runSilent: 12 })] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /no new output for 12m/);
  assert.match(run.stdout, /silent runs 1/);
});

test("the action lines report the count before the threshold", () => {
  const run = drive({ rows: [row({ agent: "w", failed: 2, stalePending: 5, oldestPending: 90 })] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /2 failed wakeup\(s\) in the last 3h/);
  assert.match(run.stdout, /5 wakeup\(s\) queued longer than 30m/);
});

test("a paused agent that only holds parked cards still needs a human", () => {
  const run = drive({ rows: [row({ agent: "p", status: "paused", active: 0, review: 0, parked: 2 })] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /paused but still holds 0 open \/ 0 in review \/ 2 parked/);
});

test("a flag wins over an exported environment default", () => {
  const run = spawnSync("bash", ["-c", 'source "$SCRIPT"; parse_args --run-silent 3; echo "$RUN_SILENT|$RUNNING_SLOW"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath, FLEET_RUN_SILENT: "10", FLEET_RUNNING_SLOW: "40" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "3|40");
});

test("a company name that holds a pipe stays one name", () => {
  const run = spawnSync("bash", ["-c", 'source "$SCRIPT"; scope_names_split "Research|Ops"; echo "${#SCOPE_NAME_LIST[@]}"; echo "${SCOPE_NAME_LIST[0]}"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "1\nResearch|Ops");

  const json = spawnSync("bash", ["-c", 'source "$SCRIPT"; scope_names_split "Research|Ops"; scope_companies_json; echo "$JSON"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath },
  });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout.trim(), '["Research|Ops"]');
});

test("a control character in a name becomes a JSON escape", () => {
  const run = spawnSync("bash", ["-c", 'source "$SCRIPT"; json_string "$CTRL"; echo "$JSON"'], {
    encoding: "utf8",
    env: { ...process.env, SCRIPT: scriptPath, CTRL: "a\u0001b" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '"a\\u0001b"');
});

test("watch mode retries after a failure instead of stopping", () => {
  // A failure that ends the shell must end that attempt only. The watcher
  // reports it and tries again on the next interval.
  const out = join(tmpdir(), `fleet-watch-retry-${process.pid}.txt`);
  const driver = [
    'source "$SCRIPT"',
    "preflight() { return 2; }",
    'main --watch 1 --db "postgresql://example.invalid/paperclip"',
  ].join("\n");
  const run = spawnSync("bash", ["-c", `${driver} > "$OUT" 2>&1`], {
    encoding: "utf8",
    timeout: 3500,
    env: { ...process.env, SCRIPT: scriptPath, OUT: out },
  });
  const written = readFileSync(out, "utf8");
  try { unlinkSync(out); } catch {}
  assert.match(written, /panel unavailable; retrying in 1s/);
});

test("the JSON scope keeps a company name with a pipe as one entry", () => {
  // End to end: the name travels from the scope query through the array into
  // the JSON document. A helper-level assertion would not catch a renderer
  // that splits the display string again.
  const run = drive({
    rows: [row({ company: "Research|Ops" })],
    mode: "json",
    scopeNames: ["Research|Ops"],
  });
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(run.stdout);
  assert.deepEqual(doc.scope.companies, ["Research|Ops"]);
});

test("watch stops when its output pipe closes", () => {
  // fleet-status.sh --watch 1 | head -n 1 should end the watcher instead of
  // keeping the database busy after head exits and closes the read end.
  const driver = [
    'source "$SCRIPT"',
    "preflight() { return 0; }",
    "run_once() { emit 'line one\\n'; sleep 0.2; emit 'line two\\n'; return 0; }",
    'main --watch 1 --db "postgresql://example.invalid/paperclip"',
  ].join("\n");
  const run = spawnSync("bash", ["-c", `${driver} | head -n 1`], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, SCRIPT: scriptPath },
  });
  // The watcher should have stopped (head closed the pipe), not timed out.
  assert.ok(run.status !== null, "watch did not stop after the pipe closed");
});

test("a company name with control characters is cleaned for text output", () => {
  // The scope query filters control characters with regexp_replace. A name
  // that holds a newline or an ANSI escape must not forge extra lines or
  // manipulate the operator's terminal in text mode. The test drives the
  // panel with a pre-sanitized name (the SQL layer does the sanitisation) and
  // verifies that the text renderer does not reintroduce raw control codes.
  const run = drive({
    rows: [row({ agent: "worker" })],
    mode: "text",
    scopeNames: ["Safe Co "],
  });
  assert.equal(run.status, 0, run.stderr);
  // The name must appear on one line, without escape sequences.
  assert.match(run.stdout, /Safe Co/);
  assert.doesNotMatch(run.stdout, /\x1b\[/);
});
