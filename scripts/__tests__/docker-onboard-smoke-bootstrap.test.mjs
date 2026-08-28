import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../docker-onboard-smoke.sh", import.meta.url).pathname;

/**
 * The admin bootstrap in `docker-onboard-smoke.sh`, exercised without Docker.
 *
 * `/api/health` answering 200 is not a promise that auth can serve a write: the
 * container cold-installs paperclipai and brings up embedded postgres, and there
 * is a window where health answers while a sign-up still fails. A single
 * un-retried attempt in that window is what made the nightly release smoke flake
 * — it failed on 2026-08-21, -23, -24, -26 and -27 while passing on the days
 * between, on identical inputs.
 *
 * These tests drive the real functions out of the shipped script with a stubbed
 * request helper. Extracting them rather than restating them keeps the test
 * honest: a copy would drift from what actually runs in CI.
 */

const source = fs.readFileSync(script, "utf8");

function extractFunction(name) {
  // Anchored to the start of a line: a bare indexOf for `sign_up_or_sign_in() {`
  // also matches inside `try_sign_up_or_sign_in() {`, which is defined first.
  const marker = `\n${name}() {`;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${name} not found at column 0 in docker-onboard-smoke.sh`);
  const start = at + 1;
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at column 0`);
  return source.slice(start, end + 3);
}

/**
 * Runs the bootstrap against a scripted sequence of responses.
 *
 * Each entry in `attempts` is `[signUpStatus, signInStatus]` for one pass of the
 * loop; "000" stands for curl failing to connect at all, which is what the
 * server returns while it is still coming up — and which produces the empty
 * body the real failures showed.
 */
function runBootstrap(attempts, { retrySeconds = 6 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-bootstrap-"));
  try {
    const table = attempts.map((pair) => pair.join(" ")).join("\n");
    fs.writeFileSync(path.join(dir, "responses"), `${table}\n`);

    // The helper is called as `$(...)`, so a counter held in a shell variable
    // would die with that subshell. It lives in a file for the same reason.
    const harness = `
set -uo pipefail
TMP_DIR=${JSON.stringify(dir)}
COUNTER="$TMP_DIR/attempt"
echo 0 > "$COUNTER"
PAPERCLIP_PUBLIC_URL="http://stub"
SMOKE_ADMIN_NAME="Smoke Admin"
SMOKE_ADMIN_EMAIL="smoke-admin@paperclip.local"
SMOKE_ADMIN_PASSWORD="pw"
SMOKE_BOOTSTRAP_RETRY_SECONDS=${retrySeconds}

post_json_with_cookies() {
  local url="$1" body="$2" out="$3"
  local idx line code
  idx="$(cat "$COUNTER")"
  line="$(sed -n "$((idx + 1))p" "$TMP_DIR/responses")"
  [[ -z "$line" ]] && line="000 000"
  if [[ "$url" == *sign-up* ]]; then
    code="\${line%% *}"
    [[ "$code" =~ ^2 ]] && echo $((idx + 1)) > "$COUNTER"
  else
    code="\${line##* }"
    echo $((idx + 1)) > "$COUNTER"
  fi
  if [[ "$code" == "000" ]]; then : > "$out"; else echo "{\\"stub\\":$code}" > "$out"; fi
  printf '%s' "$code"
}

${extractFunction("try_sign_up_or_sign_in")}
${extractFunction("sign_up_or_sign_in")}

sign_up_or_sign_in
`;
    const started = Date.now();
    const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    return {
      code: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      elapsedMs: Date.now() - started,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("succeeds when sign-up works on the first attempt", () => {
  const r = runBootstrap([["200", "000"]]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created admin user/);
});

test("falls back to sign-in for a data dir that already holds the admin", () => {
  const r = runBootstrap([["409", "200"]]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /signed in existing admin user/);
});

test("retries past an auth stack that is not up yet", () => {
  // The flake: health answers, the first sign-ups cannot connect, and the
  // stack is serving moments later. One attempt failed here; the loop rides it out.
  const r = runBootstrap([
    ["000", "000"],
    ["000", "000"],
    ["200", "000"],
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created admin user/);
});

test("retries a 5xx and then signs in", () => {
  const r = runBootstrap([
    ["000", "000"],
    ["500", "500"],
    ["409", "200"],
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /signed in existing admin user/);
});

test("gives up at the deadline rather than hanging", () => {
  const r = runBootstrap([["000", "000"]], { retrySeconds: 4 });
  assert.equal(r.code, 1);
  // Bounded on both sides: it must actually wait, and must not run away.
  assert.ok(r.elapsedMs >= 4000, `gave up too early: ${r.elapsedMs}ms`);
  assert.ok(r.elapsedMs < 30000, `overran the deadline: ${r.elapsedMs}ms`);
});

test("bounds every request so the deadline can actually be reached", () => {
  // The retry loop only checks its deadline between attempts. An unbounded curl
  // that connects and then stalls never returns to be checked, so the job would
  // run to its own 45-minute timeout printing nothing — strictly worse than the
  // single-attempt failure this change replaced. Asserted on the script text
  // because the harness above stubs the helper out.
  const helper = extractFunction("post_json_with_cookies");
  assert.match(helper, /--max-time/, "post_json_with_cookies must cap request duration");
  assert.match(helper, /--connect-timeout/, "post_json_with_cookies must cap connect time");
});

test("reports the HTTP status it saw, not just an empty body", () => {
  // The reason this flake went a week without a diagnosis: the failure printed
  // the response body, and a sign-up that never connected has none. The status
  // was in hand the whole time and was not being surfaced.
  const r = runBootstrap([["000", "000"]], { retrySeconds: 4 });
  assert.match(r.stderr, /Sign-up HTTP 000/);
  assert.match(r.stderr, /Sign-in HTTP 000/);
  assert.match(r.stderr, /attempts over 4s/);
});
