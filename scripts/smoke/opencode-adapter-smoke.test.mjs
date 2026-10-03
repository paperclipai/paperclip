import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Opt-in LIVE smoke for the opencode_local adapter's OpenCode v1 + v2 support.
// Runs real OpenCode CLIs and proves the adapter's own parsers accept their output.
// Skip-safe: everything is skipped unless OPENCODE_SMOKE=1 (CI default).
//
//   OPENCODE_SMOKE=1 node --test scripts/smoke/opencode-adapter-smoke.test.mjs
//
// Override binaries (split on whitespace):
//   OPENCODE_SMOKE_V1_CMD  default: npx -y opencode-ai@1.18.32   (v1 line, npm opencode-ai)
//   OPENCODE_SMOKE_V2_CMD  default: npx -y @opencode/cli@2.0.18  (v2 line, npm @opencode/cli)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SMOKE_ENABLED = process.env.OPENCODE_SMOKE === "1";
const V1_CMD = (process.env.OPENCODE_SMOKE_V1_CMD || "npx -y opencode-ai@1.18.32").trim().split(/\s+/);
const V2_CMD = (process.env.OPENCODE_SMOKE_V2_CMD || "npx -y @opencode/cli@2.0.18").trim().split(/\s+/);
const RUN_TIMEOUT_MS = 180_000;
const SMOKE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-adapter-smoke-"));

const AUTH_FAILURE = /auth|login|api key|credential|unauthori[sz]ed|no provider|ENOENT/i;

function run(cmdParts, args, options = {}) {
  const [bin, ...binArgs] = cmdParts;
  return spawnSync(bin, [...binArgs, ...args], {
    cwd: SMOKE_CWD,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    ...options,
  });
}

function evidence(label, result) {
  const firstLine = (result.stdout || result.stderr || "").split(/\r?\n/).find((l) => l.trim());
  console.log(`[smoke] ${label} -> exit=${result.status} signal=${result.signal ?? "-"} out=${(firstLine || "").slice(0, 120)}`);
}

function skipIfUnmet(t, result, label) {
  if (result.error || result.status !== 0) {
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (AUTH_FAILURE.test(text) || result.error?.code === "ENOENT") {
      t.skip(`${label}: environment unavailable (${(text.split(/\r?\n/).find((l) => l.trim()) || "no output").slice(0, 120)})`);
      return true;
    }
  }
  return false;
}

// Import the adapter's real parsers (Node 24 erasable-type stripping). Falls back
// to skipping those assertions where a TS import is unavailable.
async function loadAdapterParsers(t) {
  try {
    const version = await import(
      pathToFileURL(path.join(repoRoot, "packages/adapters/opencode-local/src/server/version.ts")).href
    );
    const parse = await import(
      pathToFileURL(path.join(repoRoot, "packages/adapters/opencode-local/src/server/parse.ts")).href
    );
    return { ...version, ...parse };
  } catch (error) {
    // Note only: the behavioral assertions below stay authoritative. Parser
    // correctness is covered by the vitest suites (121 tests incl. fake-binary).
    console.log(`[smoke] note: adapter TS modules not importable (${error.message.slice(0, 120)}); skipping parser cross-checks only`);
    return null;
  }
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

for (const [lineName, cmdParts, expectedLine] of [
  ["v1", V1_CMD, "v1"],
  ["v2", V2_CMD, "v2"],
]) {
  test(
    `opencode ${lineName}: --version parses via adapter version.ts`,
    { skip: SMOKE_ENABLED ? false : "set OPENCODE_SMOKE=1 to run live smoke" },
    async (t) => {
      const parsers = await loadAdapterParsers(t);
      const result = run(cmdParts, ["--version"]);
      evidence(`${lineName} --version`, result);
      if (skipIfUnmet(t, result, `${lineName} --version`)) return;
      assert.equal(result.status, 0, `${lineName} --version failed: ${result.stderr}`);
      if (!parsers?.parseOpenCodeVersion) return;
      const version = parsers.parseOpenCodeVersion(result.stdout);
      assert.ok(version, `${lineName} --version output not parseable: ${JSON.stringify(result.stdout)}`);
      assert.equal(parsers.classifyOpenCodeLine(version), expectedLine);
    },
  );

  test(
    `opencode ${lineName}: models lists provider/model ids`,
    { skip: SMOKE_ENABLED ? false : "set OPENCODE_SMOKE=1 to run live smoke" },
    (t) => {
      // v2: plain `models` reads the operator's auth via the shared background
      // service (a private --standalone server lists nothing). The service can
      // be transiently wedged -> empty output with exit 0; retry once.
      const args = ["models"];
      let result = run(cmdParts, args);
      if (lineName === "v2" && result.status === 0 && !(result.stdout || "").trim()) {
        console.log(`[smoke] note: ${lineName} models empty output, retrying once`);
        result = run(cmdParts, args);
      }
      evidence(`${lineName} models`, result);
      if (skipIfUnmet(t, result, `${lineName} models`)) return;
      assert.equal(result.status, 0, `${lineName} models failed: ${result.stderr}`);
      const ids = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^\s/]+\/[^\s]+$/.test(l));
      assert.ok(ids.length >= 1, `${lineName} models produced no provider/model lines (stdout=${JSON.stringify(result.stdout.slice(0, 200))} stderr=${JSON.stringify(result.stderr.slice(0, 200))})`);
    },
  );

  test(
    `opencode ${lineName}: run --format json delivers prompt text via stdin`,
    { skip: SMOKE_ENABLED ? false : "set OPENCODE_SMOKE=1 to run live smoke" },
    async (t) => {
      const parsers = await loadAdapterParsers(t);
      const prompt = "Reply with exactly: SMOKE-PONG. Do not use any tools.";
      // The adapter delivers prompts via stdin on BOTH lines — that is its real
      // execute() path (runAdapterExecutionTargetProcess pipes the prompt).
      // v2 accepts stdin prompt delivery with --standalone (verified on
      // 2.0.18; without --standalone the shared background service cancels it).
      const result = run(
        cmdParts,
        ["run", "--format", "json", ...(lineName === "v2" ? ["--standalone"] : [])],
        { input: prompt },
      );
      evidence(`${lineName} run`, result);
      if (skipIfUnmet(t, result, `${lineName} run`)) return;
      assert.equal(result.status, 0, `${lineName} run failed: ${result.stderr || result.stdout}`);
      let events;
      try {
        events = parseJsonLines(result.stdout);
      } catch (error) {
        assert.fail(`${lineName} run emitted unparseable JSONL: ${error.message}\n${result.stdout.slice(0, 500)}`);
      }
      const texts = events
        .filter((e) => e.type === "text")
        .map((e) => e.part?.text ?? "");
      assert.ok(texts.some((text) => text.includes("SMOKE-PONG")), `${lineName} run missing SMOKE-PONG text part`);
      const sawStepFinish = events.some((e) => e.type === "step_finish");
      if (!sawStepFinish) {
        // Known v2 quirk: text-only runs omit step_finish (usage stays 0). Report, don't fail.
        console.log(`[smoke] note: ${lineName} run emitted no step_finish (usage=0)`);
      }
      if (parsers?.parseOpenCodeJsonl) {
        // parseOpenCodeJsonl returns { sessionId, summary, usage, costUsd,
        // errorMessage, toolErrors }: collected text is joined into `summary`
        // (a string) and errors roll up into `errorMessage` (null when clean).
        const parsed = parsers.parseOpenCodeJsonl(result.stdout);
        assert.ok(
          parsed.summary.includes("SMOKE-PONG"),
          `${lineName} adapter parser summary missed SMOKE-PONG: ${JSON.stringify(parsed.summary.slice(0, 200))}`,
        );
        assert.equal(
          parsed.errorMessage,
          null,
          `${lineName} adapter parser surfaced errors for a clean run: ${parsed.errorMessage}`,
        );
      }
    },
  );
}

test(
  "opencode v2: --variant is the expected v2 break (run must fail)",
  { skip: SMOKE_ENABLED ? false : "set OPENCODE_SMOKE=1 to run live smoke" },
  (t) => {
    const result = run(V2_CMD, ["run", "--format", "json", "--standalone", "--variant", "high", "x"]);
    evidence("v2 run --variant", result);
    if (skipIfUnmet(t, result, "v2 run --variant")) return;
    assert.notEqual(result.status, 0, "v2 unexpectedly accepted --variant");
  },
);
