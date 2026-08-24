import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOW_MARKER,
  collectScannableFiles,
  extractAllowReason,
  extractCurlBlocks,
  findBareCurlOffenses,
  isInScanScope,
  runCheck,
} from "../check-curl-status-gate.mjs";

// ── The negative control ─────────────────────────────────────────────────
// This is the whole point of the ticket: prove the gate FIRES on the exact
// idiom RBR-882/RBR-919 was about. A gate that cannot be shown to fail is
// decorative.
test("NEGATIVE CONTROL: fires on a reintroduced bare `curl -sS -X POST ... | jq`", () => {
  const text = [
    "```bash",
    'curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$id/comments" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{\"comment\":\"done\"}' | jq .",
    "```",
  ].join("\n");

  const offenses = findBareCurlOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].kind, "bare_curl");
  assert.equal(offenses[0].lineNumber, 2);
});

test("NEGATIVE CONTROL: fires end-to-end through runCheck with a real file", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "curl-gate-"));
  try {
    mkdirSync(path.join(repoRoot, "skills/paperclip/references"), { recursive: true });
    const relative = "skills/paperclip/references/regressed.md";
    writeFileSync(
      path.join(repoRoot, relative),
      'curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/abc" -d @- | jq .status\n',
      "utf8",
    );

    const errors = [];
    const code = runCheck({
      repoRoot,
      files: [relative],
      log: () => {},
      error: (line) => errors.push(line),
    });

    assert.equal(code, 1);
    assert.ok(errors.join("\n").includes(relative));
    assert.ok(errors.join("\n").includes("no status gate"));
    // The failure message must tell the author what to do instead.
    assert.ok(errors.join("\n").includes("--fail-with-body"));
    assert.ok(errors.join("\n").includes("pc-api.sh"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Positive controls: the blessed forms must pass ───────────────────────
test("passes `--fail-with-body`", () => {
  const text = 'curl --fail-with-body -sS -X POST "$PAPERCLIP_API_URL/api/issues" -d @-\n';
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("passes a `%{http_code}` write-out gate", () => {
  const text =
    "curl -sS -X POST -w '%{http_code}' -o \"$response_file\" \"$PAPERCLIP_API_URL/api/artifacts\"\n";
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("passes a gate placed on a continuation line", () => {
  const text = [
    'curl -sS -X PATCH "$api/issues/$id" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    "  -w '%{http_code}' \\",
    "  --data-binary @-",
  ].join("\n");
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("passes a delegation to the blessed pc-api.sh helper", () => {
  const text = 'pc-api.sh -X POST "$PAPERCLIP_API_URL/api/issues/$id/comments" --data-binary @-\n';
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("passes short `-f` clusters but not uppercase `-F` form uploads", () => {
  const gated = 'curl -sSf -X POST "$PAPERCLIP_API_URL/api/issues" -d @-\n';
  assert.deepEqual(findBareCurlOffenses(gated), []);

  const formUpload = 'curl -sS -X POST "$PAPERCLIP_API_URL/api/artifacts" -F file=@a.png\n';
  assert.equal(findBareCurlOffenses(formUpload).length, 1);
});

// ── Scope: only mutating Paperclip calls ─────────────────────────────────
test("ignores non-mutating reads", () => {
  const text = 'curl -sS "$PAPERCLIP_API_URL/api/issues/$id" | jq .status\n';
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("ignores mutations that do not target a Paperclip API path", () => {
  const text = 'curl -sS -X POST "https://example.com/webhook" -d @-\n';
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("ignores known external APIs that happen to use an /api/ path", () => {
  const text = 'curl -sS -X POST "https://discord.com/api/webhooks/1/abc" -d @-\n';
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("catches every mutating verb", () => {
  for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
    const text = `curl -sS -X ${verb} "$PAPERCLIP_API_URL/api/issues/x" -d @-\n`;
    assert.equal(findBareCurlOffenses(text).length, 1, `expected ${verb} to be gated`);
  }
});

test("catches the --request=POST spelling", () => {
  const text = 'curl -sS --request=POST "$PAPERCLIP_API_URL/api/issues/x" -d @-\n';
  assert.equal(findBareCurlOffenses(text).length, 1);
});

test("catches a curl on the right-hand side of a pipe", () => {
  const text =
    'jq -n \'{status:"done"}\' | curl -sS -X PATCH "$api/issues/x" --data-binary @-\n';
  assert.equal(findBareCurlOffenses(text).length, 1);
});

// ── Allowlist with required justification ───────────────────────────────
test("allowlist marker with a reason suppresses the offense", () => {
  const text = [
    `# ${ALLOW_MARKER}: deliberately shows the silent-drop failure mode from RBR-882`,
    'curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/x" -d @- | jq .',
  ].join("\n");
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("allowlist marker works in an HTML comment above a fenced block", () => {
  const text = [
    `<!-- ${ALLOW_MARKER}: anti-example for the docs section below -->`,
    "",
    "```bash",
    'curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/x" -d @- | jq .',
    "```",
  ].join("\n");
  assert.deepEqual(findBareCurlOffenses(text), []);
});

test("allowlist marker WITHOUT a justification is itself an offense", () => {
  const text = [
    `# ${ALLOW_MARKER}`,
    'curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/x" -d @- | jq .',
  ].join("\n");
  const offenses = findBareCurlOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].kind, "unjustified_allow");
});

test("allowlist marker too far above the invocation does not apply", () => {
  const text = [
    `# ${ALLOW_MARKER}: stale marker, five lines up`,
    "",
    "",
    "",
    "",
    'curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/x" -d @-',
  ].join("\n");
  assert.equal(findBareCurlOffenses(text).length, 1);
});

test("extractAllowReason strips comment syntax and separators", () => {
  assert.equal(extractAllowReason("no marker here"), null);
  assert.equal(extractAllowReason(`# ${ALLOW_MARKER}`), "");
  assert.equal(extractAllowReason(`# ${ALLOW_MARKER}:   because reasons`), "because reasons");
  assert.equal(extractAllowReason(`<!-- ${ALLOW_MARKER}: anti-example -->`), "anti-example");
  assert.equal(extractAllowReason(`/* ${ALLOW_MARKER} — anti-example */`), "anti-example");
});

// ── Block extraction ────────────────────────────────────────────────────
test("extractCurlBlocks joins backslash continuations into one logical command", () => {
  const text = ["curl -sS \\", "  -X POST \\", '  "$api/issues"', "echo done"].join("\n");
  const blocks = extractCurlBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].startLine, 1);
});

test("extractCurlBlocks does not swallow prose past a blank line", () => {
  const text = ["curl -sS -X POST \\", "", "Some prose about --fail-with-body."].join("\n");
  const blocks = extractCurlBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 1);
});

test("extractCurlBlocks finds two independent invocations", () => {
  const text = [
    'curl -sS -X POST "$api/a" -d @-',
    "echo mid",
    'curl -sS -X POST "$api/b" -d @-',
  ].join("\n");
  assert.equal(extractCurlBlocks(text).length, 2);
});

// ── Scope resolution ────────────────────────────────────────────────────
test("isInScanScope covers skills/, docs/, and adapter server dirs only", () => {
  assert.ok(isInScanScope("skills/paperclip/SKILL.md"));
  assert.ok(isInScanScope("docs/guides/openclaw-docker-setup.md"));
  assert.ok(isInScanScope("packages/adapters/hermes/src/server/routes.ts"));

  assert.ok(!isInScanScope("server/src/routes/issues.ts"));
  assert.ok(!isInScanScope("packages/adapters/hermes/src/client/api.ts"));
  assert.ok(!isInScanScope("skills/paperclip/logo.png"));
  assert.ok(!isInScanScope("docs/node_modules/pkg/README.md"));
  assert.ok(!isInScanScope("README.md"));
});

test("collectScannableFiles walks the scan roots and skips out-of-scope files", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "curl-gate-walk-"));
  try {
    mkdirSync(path.join(repoRoot, "skills/paperclip"), { recursive: true });
    mkdirSync(path.join(repoRoot, "docs/guides"), { recursive: true });
    mkdirSync(path.join(repoRoot, "packages/adapters/hermes/src/server"), { recursive: true });
    mkdirSync(path.join(repoRoot, "packages/adapters/hermes/src/client"), { recursive: true });
    mkdirSync(path.join(repoRoot, "server/src"), { recursive: true });

    writeFileSync(path.join(repoRoot, "skills/paperclip/SKILL.md"), "", "utf8");
    writeFileSync(path.join(repoRoot, "docs/guides/a.md"), "", "utf8");
    writeFileSync(path.join(repoRoot, "packages/adapters/hermes/src/server/x.ts"), "", "utf8");
    writeFileSync(path.join(repoRoot, "packages/adapters/hermes/src/client/y.ts"), "", "utf8");
    writeFileSync(path.join(repoRoot, "server/src/z.ts"), "", "utf8");

    assert.deepEqual(collectScannableFiles(repoRoot), [
      "docs/guides/a.md",
      "packages/adapters/hermes/src/server/x.ts",
      "skills/paperclip/SKILL.md",
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runCheck is green on a clean file set and tolerates deleted paths", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "curl-gate-clean-"));
  try {
    mkdirSync(path.join(repoRoot, "skills"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "skills/ok.md"),
      'curl --fail-with-body -sS -X POST "$PAPERCLIP_API_URL/api/issues" -d @-\n',
      "utf8",
    );

    const logs = [];
    const code = runCheck({
      repoRoot,
      files: ["skills/ok.md", "skills/deleted-by-this-pr.md"],
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
    });

    assert.equal(code, 0);
    assert.ok(logs.join("\n").includes("No status-blind"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Pipeline wiring ─────────────────────────────────────────────────────
// The gate is only real if it runs. Pin the wiring the same way
// release-verify-workflow.test.mjs pins its workflow contract.
test("gate and its test are wired into the PR policy job", () => {
  const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pr = readFileSync(path.join(workflowRoot, ".github/workflows/pr.yml"), "utf8");

  assert.match(pr, /node \.\/scripts\/check-curl-status-gate\.mjs "\$\{changed_paths\[@\]\}"/);
  assert.match(pr, /node --test \.\/scripts\/__tests__\/check-curl-status-gate\.test\.mjs/);

  // Both steps must sit in the same `policy` job as the sibling token/push checks,
  // i.e. before the next top-level job key.
  const policyStart = pr.indexOf("\n  policy:");
  const nextJobMatch = pr.slice(policyStart + 1).match(/\n  [a-zA-Z0-9_-]+:\n/);
  const policyEnd = nextJobMatch
    ? policyStart + 1 + nextJobMatch.index
    : pr.length;
  const policyJob = pr.slice(policyStart, policyEnd);
  assert.ok(policyJob.includes("check-curl-status-gate.mjs"));

  const pkg = JSON.parse(readFileSync(path.join(workflowRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:curl-status-gate"], "node scripts/check-curl-status-gate.mjs");
  assert.equal(
    pkg.scripts["test:check-curl-status-gate"],
    "node --test scripts/__tests__/check-curl-status-gate.test.mjs",
  );
});
