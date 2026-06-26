import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /Docker/);
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});
