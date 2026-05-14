import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

function runHelper(script, args, input) {
  return execFileSync("bash", [script, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    input,
  }).trim();
}

test("issue update helper preserves stdin markdown with shell-looking text", () => {
  const body = [
    "Update",
    "",
    "- Synthetic command text: $(printf DO_NOT_RUN)",
    "- Synthetic env text: ${SYNTHETIC_SECRET}",
    "- Inline code: `echo no`",
  ].join("\n");

  const raw = runHelper(
    "scripts/paperclip-issue-update.sh",
    ["--issue-id", "issue-123", "--status", "in_progress", "--dry-run"],
    body,
  );
  const payload = JSON.parse(raw);

  assert.equal(payload.status, "in_progress");
  assert.equal(payload.comment, body);
});

test("issue comment helper preserves stdin markdown with shell-looking text", () => {
  const body = [
    "Comment",
    "",
    "- Synthetic command text: $(printf DO_NOT_RUN)",
    "- Synthetic env text: ${SYNTHETIC_SECRET}",
    "- Inline code: `echo no`",
  ].join("\n");

  const raw = runHelper(
    "scripts/paperclip-issue-comment.sh",
    ["--issue-id", "issue-123", "--dry-run"],
    body,
  );
  const payload = JSON.parse(raw);

  assert.deepEqual(payload, { body });
});

test("inline update comments reject shell-expansion-looking text", () => {
  const result = spawnSync(
    "bash",
    [
      "scripts/paperclip-issue-update.sh",
      "--issue-id",
      "issue-123",
      "--comment",
      "synthetic $(printf DO_NOT_RUN)",
      "--dry-run",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing shell-risky --comment content/);
});

test("inline comment bodies reject shell-expansion-looking text", () => {
  const result = spawnSync(
    "bash",
    [
      "scripts/paperclip-issue-comment.sh",
      "--issue-id",
      "issue-123",
      "--body",
      "synthetic ${SYNTHETIC_SECRET}",
      "--dry-run",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing shell-risky --body content/);
});
