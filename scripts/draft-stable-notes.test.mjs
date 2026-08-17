import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const script = join(repoRoot, "scripts", "draft-stable-notes.sh");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}

function commit(dir, subject) {
  git(dir, "commit", "--allow-empty", "-m", subject);
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "draft-stable-notes-"));
  git(dir, "init", "-q", "-b", "master");
  return dir;
}

function runDraft(dir, betaVersion, extraArgs = []) {
  const out = join(dir, "draft.md");
  const stdout = execFileSync(
    "bash",
    [script, betaVersion, "--repo-dir", dir, "--out", out, ...extraArgs],
    { encoding: "utf8" }
  );
  return { stdout, body: readFileSync(out, "utf8") };
}

test("drafts grouped notes from the newest stable tag to the beta source", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: ancient work (#1)");
  git(dir, "tag", "v2026.100.0");
  commit(dir, "feat: add widgets (#2)");
  commit(dir, "fix(ui): unbreak widget list (#3)");
  commit(dir, "chore: bump deps (#4)");
  commit(dir, "feat(api)!: breaking widget API (#5)");
  git(dir, "tag", "beta/v2026.101.0-beta.0");

  const { body } = runDraft(dir, "2026.101.0-beta.0");

  assert.match(body, /^# Paperclip stable draft — from beta 2026\.101\.0-beta\.0/);
  assert.match(body, /## Features\n\n- feat\(api\)!: breaking widget API \(#5\)\n- feat: add widgets \(#2\)/);
  assert.match(body, /## Fixes\n\n- fix\(ui\): unbreak widget list \(#3\)/);
  assert.match(body, /## Other changes\n\n- chore: bump deps \(#4\)/);
  assert.doesNotMatch(body, /ancient work/);
});

test("uses the nearest ancestor stable tag, not the newest by version", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: old work (#1)");
  git(dir, "tag", "v2026.100.0");
  commit(dir, "feat: mid work (#2)");
  git(dir, "tag", "beta/v2026.150.0-beta.0");
  commit(dir, "feat: new work (#3)");
  git(dir, "tag", "v2026.200.0");

  // Promoting the older source must draft against its own lineage's last
  // stable (v2026.100.0), not the newer v2026.200.0 that already contains
  // it — that range would be empty.
  const { body } = runDraft(dir, "2026.150.0-beta.0");

  assert.match(body, /- feat: mid work \(#2\)/);
  assert.doesNotMatch(body, /old work/);
  assert.doesNotMatch(body, /new work/);
});

test("falls back to the previous beta tag when no stable tag exists", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: first-train work (#1)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  commit(dir, "fix: second-train fix (#2)");
  git(dir, "tag", "beta/v2026.101.0-beta.0");

  const { body } = runDraft(dir, "2026.101.0-beta.0");

  assert.match(body, /- fix: second-train fix \(#2\)/);
  assert.doesNotMatch(body, /first-train work/);
});

test("covers full history when no earlier marker exists", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: the very first commit (#1)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");

  const { body } = runDraft(dir, "2026.100.0-beta.0");

  assert.match(body, /- feat: the very first commit \(#1\)/);
});

test("writes to releases/beta/v<version>.md inside the repo by default", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: default path (#1)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");

  execFileSync("bash", [script, "2026.100.0-beta.0", "--repo-dir", dir], {
    encoding: "utf8",
  });
  const body = readFileSync(
    join(dir, "releases", "beta", "v2026.100.0-beta.0.md"),
    "utf8"
  );
  assert.match(body, /- feat: default path \(#1\)/);
});

test("rejects a malformed beta version", () => {
  const dir = makeFixtureRepo();
  assert.throws(() =>
    execFileSync("bash", [script, "2026.100.0", "--repo-dir", dir], {
      encoding: "utf8",
      stdio: "pipe",
    })
  );
});

test("rejects a beta version whose tag does not exist", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: unrelated (#1)");
  assert.throws(() =>
    execFileSync("bash", [script, "2026.100.0-beta.9", "--repo-dir", dir], {
      encoding: "utf8",
      stdio: "pipe",
    })
  );
});
