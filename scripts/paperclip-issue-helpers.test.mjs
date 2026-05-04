// Tests for scripts/paperclip-issue-comment.sh and scripts/paperclip-issue-update.sh.
//
// Run with: node --test scripts/paperclip-issue-helpers.test.mjs
//
// These tests invoke the helpers in --dry-run mode and verify the JSON payload
// they would send to the Paperclip API. The bodies cover the multi-level
// shell-escaping bug class that collapses or corrupts markdown containing
// newlines, fenced code blocks, nested backticks, and special characters when
// inlined into argument strings.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMENT_SH = resolve(__dirname, "paperclip-issue-comment.sh");
const UPDATE_SH = resolve(__dirname, "paperclip-issue-update.sh");

function runDryRun(scriptPath, args, stdin = "", extraEnv = {}) {
  // Strip any inherited PAPERCLIP_TASK_ID so tests can assert "missing
  // --issue-id" behaviour deterministically. Other PAPERCLIP_* vars are
  // irrelevant under --dry-run because the script never makes the HTTP call.
  const env = { ...process.env, ...extraEnv };
  delete env.PAPERCLIP_TASK_ID;
  const result = spawnSync("bash", [scriptPath, ...args], {
    input: stdin,
    encoding: "utf-8",
    env,
  });
  return result;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pc-helpers-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURES = {
  multilineMarkdown: [
    "## Update",
    "",
    "- Step one",
    "- Step two",
    "",
    "Next action: open the PR.",
  ].join("\n"),

  fencedPythonBlock: [
    "Here is the repro:",
    "",
    "```python",
    "def post_comment(issue_id: str, body: str) -> None:",
    '    payload = {"body": body}',
    "    print(payload)",
    "```",
    "",
    "End of block.",
  ].join("\n"),

  nestedBackticks: [
    "Inline `code` and an embedded fence:",
    "",
    "````md",
    "```python",
    "x = 1  # nested fence",
    "```",
    "````",
    "",
    "Done.",
  ].join("\n"),

  specialCharacters: [
    'Quotes: "double" and ‘curly’ and \\backslash\\.',
    "Tabs:\there.",
    "Unicode: ✅ ⚠️ 🚀",
    "Shell metas: $VAR ${VAR} `subshell` $(cmd) | & ; > <",
    "Backslash-n literal: \\n should NOT become a newline.",
  ].join("\n"),
};

// Real-world originator pattern: a node -e command line that inlined a fenced markdown
// body into a multi-level escaped JS string. The body itself is what we care
// about preserving end-to-end.
FIXTURES.shellEscapeOriginator = [
  "Postmortem note: the originator command was inlined into node -e:",
  "",
  "```bash",
  "node -e 'fetch(\"http://localhost:3100/api/issues/PAP-1/comments\", {",
  "  method: \"POST\",",
  "  headers: { \"Content-Type\": \"application/json\" },",
  "  body: JSON.stringify({ body: `### multi-line",
  "with backticks \\` and quotes \"\"` })",
  "})'",
  "```",
  "",
  "The originator command above is exactly what the helper makes obsolete.",
].join("\n");

for (const [name, body] of Object.entries(FIXTURES)) {
  test(`comment helper preserves body verbatim: ${name} (stdin)`, () => {
    const r = runDryRun(COMMENT_SH, ["--issue-id", "PAP-1", "--dry-run"], body);
    assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ["body"]);
    assert.equal(payload.body, body, "body must round-trip without mutation");
  });

  test(`comment helper preserves body verbatim: ${name} (--body-file)`, () => {
    withTempDir((dir) => {
      const path = join(dir, "body.md");
      writeFileSync(path, body, "utf-8");
      const r = runDryRun(COMMENT_SH, [
        "--issue-id",
        "PAP-1",
        "--body-file",
        path,
        "--dry-run",
      ]);
      assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
      const payload = JSON.parse(r.stdout);
      assert.equal(payload.body, body, "body must round-trip without mutation");
    });
  });

  test(`update helper preserves body verbatim: ${name} (stdin + status)`, () => {
    const r = runDryRun(
      UPDATE_SH,
      ["--issue-id", "PAP-1", "--status", "in_review", "--dry-run"],
      body,
    );
    assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.status, "in_review");
    assert.equal(payload.comment, body, "comment must round-trip without mutation");
  });
}

test("comment helper rejects empty stdin body", () => {
  const r = runDryRun(COMMENT_SH, ["--issue-id", "PAP-1", "--dry-run"], "");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty/);
});

test("comment helper requires --issue-id", () => {
  const r = runDryRun(COMMENT_SH, ["--dry-run"], "hi");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--issue-id/);
});

test("update helper requires --issue-id and --status", () => {
  const noIssue = runDryRun(UPDATE_SH, ["--status", "done", "--dry-run"], "x");
  assert.notEqual(noIssue.status, 0);
  // Disable the env-derived default for this assertion.
  const noStatus = runDryRun(UPDATE_SH, ["--issue-id", "PAP-1", "--dry-run"], "x");
  assert.notEqual(noStatus.status, 0);
  assert.match(noStatus.stderr, /--status/);
});

test("update helper status-only payload (no comment, no blockers)", () => {
  const r = runDryRun(
    UPDATE_SH,
    ["--issue-id", "PAP-1", "--status", "done", "--dry-run"],
    "",
  );
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload, { status: "done" });
});

test("update helper accepts repeated --blocked-by and serialises them as an array", () => {
  const r = runDryRun(
    UPDATE_SH,
    [
      "--issue-id",
      "PAP-1",
      "--status",
      "blocked",
      "--blocked-by",
      "PAP-100",
      "--blocked-by",
      "PAP-101",
      "--dry-run",
    ],
    "Waiting on the two blockers above.",
  );
  assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload.blockedByIssueIds, ["PAP-100", "PAP-101"]);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.comment, "Waiting on the two blockers above.");
});

test("comment helper rejects unknown flags", () => {
  const r = runDryRun(COMMENT_SH, ["--issue-id", "PAP-1", "--surprise", "--dry-run"], "x");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown argument/);
});
