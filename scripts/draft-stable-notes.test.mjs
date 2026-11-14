import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const script = join(repoRoot, "scripts", "draft-stable-notes.sh");
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const needsJq = { skip: !hasJq && "jq is not installed" };
const offlineEnv = { ...process.env, DRAFT_NOTES_SKIP_PR_ENRICHMENT: "1" };

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

function runDraft(dir, betaVersion, extraArgs = [], env = offlineEnv) {
  const out = join(dir, "draft.md");
  const stdout = execFileSync(
    "bash",
    [script, betaVersion, "--repo-dir", dir, "--out", out, ...extraArgs],
    { encoding: "utf8", env }
  );
  return { stdout, body: readFileSync(out, "utf8") };
}

function installFakeGh(dir, bodies, { unavailable = false, failBatchContaining = null } = {}) {
  const binDir = join(dir, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const bodiesFile = join(dir, "fake-gh-bodies.json");
  const logFile = join(dir, "fake-gh-calls.log");
  writeFileSync(bodiesFile, JSON.stringify(bodies));
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (${JSON.stringify(unavailable)} || args[0] !== "api" || args[1] !== "graphql") process.exit(1);
const query = (args.find((arg) => arg.startsWith("query=")) || "").slice("query=".length);
const numbers = [...query.matchAll(/pullRequest\\(number: (\\d+)\\)/g)].map((match) => match[1]);
if (numbers.includes(${JSON.stringify(String(failBatchContaining))})) process.exit(1);
const bodies = JSON.parse(fs.readFileSync(${JSON.stringify(bodiesFile)}, "utf8"));
const repository = {};
const errors = [];
for (const number of numbers) {
  if (Object.hasOwn(bodies, number)) {
    repository["pr" + number] = { body: bodies[number] };
  } else {
    repository["pr" + number] = null;
    errors.push({ message: "Could not resolve to a PullRequest with the number of " + number + "." });
  }
}
process.stdout.write(JSON.stringify(errors.length ? { data: { repository }, errors } : { data: { repository } }));
process.exit(errors.length ? 1 : 0);
`,
    { mode: 0o755 }
  );
  return {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    calls: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  };
}

const whatChanged = (...bullets) =>
  ["## Thinking Path", "", "## What Changed", "", ...bullets.map((b) => `- ${b}`), "", "## Risks", ""].join("\n");

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

test("starts from the merge-base when the last stable was cut from a candidate branch", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: shipped in the stable (#1)");
  git(dir, "checkout", "-q", "-b", "candidate");
  commit(dir, "docs: release notes only (#2)");
  git(dir, "tag", "v2026.200.0");
  git(dir, "checkout", "-q", "master");
  commit(dir, "feat: next-release work (#3)");
  git(dir, "tag", "beta/v2026.201.0-beta.0");

  // The stable tag sits on the unmerged candidate branch, so it is not an
  // ancestor of the beta source. The range must start at its merge-base
  // with the source (the promoted commit), not fall back past it.
  const { body } = runDraft(dir, "2026.201.0-beta.0");

  assert.match(body, /- feat: next-release work \(#3\)/);
  assert.doesNotMatch(body, /shipped in the stable/);
  assert.doesNotMatch(body, /release notes only/);
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
    env: offlineEnv,
  });
  const body = readFileSync(
    join(dir, "releases", "beta", "v2026.100.0-beta.0.md"),
    "utf8"
  );
  assert.match(body, /- feat: default path \(#1\)/);
});

test("nests PR summaries under subjects when gh can serve them", needsJq, () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: enriched work (#42)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, { 42: whatChanged("Adds the enriched thing", "Covers it with tests") });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.match(body, /- feat: enriched work \(#42\)\n  > - Adds the enriched thing\n  > - Covers it with tests/);
});

test("falls back to the first prose lines when a PR body has no What Changed section", needsJq, () => {
  const dir = makeFixtureRepo();
  commit(dir, "fix: prose body (#8)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, {
    8: "<!-- template comment -->\r\n# Title\r\n\r\nFirst prose line.\r\nSecond prose line.\r\nThird line.\r\n",
  });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.match(body, /- fix: prose body \(#8\)\n  > First prose line\.\r\n  > Second prose line\.\r\n\n/);
});

test("survives a PR body whose What Changed section has no bullets", needsJq, () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: sparse body (#9)");
  commit(dir, "feat: empty body (#10)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, { 9: "## What Changed\n\n## Risks\n", 10: null });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.match(body, /- feat: empty body \(#10\)\n- feat: sparse body \(#9\)\n\n/);
});

test("fetches PR bodies in batched GraphQL queries, not one lookup per PR", needsJq, () => {
  const dir = makeFixtureRepo();
  const bodies = {};
  for (let pr = 1000; pr < 1120; pr += 1) {
    commit(dir, `feat: change ${pr} (#${pr})`);
    bodies[pr] = whatChanged(`Summary of ${pr}`);
  }
  commit(dir, "fix: follow-up to change 1000 (#1000)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, bodies);

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  const calls = gh.calls();
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.slice(0, 2), ["api", "graphql"]);
  for (let pr = 1000; pr < 1120; pr += 1) {
    assert.match(body, new RegExp(`- feat: change ${pr} \\(#${pr}\\)\\n  > - Summary of ${pr}\\n`));
  }
  assert.match(body, /- fix: follow-up to change 1000 \(#1000\)\n  > - Summary of 1000\n/);
});

test("keeps the resolvable PRs of a batch that also references a non-PR number", needsJq, () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: real PR (#5)");
  commit(dir, "docs: closes an issue, not a PR (#6)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, { 5: whatChanged("Real summary") });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.equal(gh.calls().length, 1);
  assert.match(body, /- feat: real PR \(#5\)\n  > - Real summary\n/);
  assert.match(body, /- docs: closes an issue, not a PR \(#6\)\n\n/);
});

test("a failed batch drops only its own excerpts", needsJq, () => {
  const dir = makeFixtureRepo();
  const bodies = {};
  for (let pr = 1; pr <= 60; pr += 1) {
    commit(dir, `fix: change ${pr} (#${pr})`);
    bodies[pr] = whatChanged(`Summary of ${pr}`);
  }
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, bodies, { failBatchContaining: 55 });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.equal(gh.calls().length, 2);
  assert.match(body, /- fix: change 50 \(#50\)\n  > - Summary of 50\n/);
  assert.match(body, /- fix: change 51 \(#51\)\n- fix: change 50 \(#50\)/);
  assert.doesNotMatch(body, /Summary of 5[1-9]|Summary of 60/);
});

test("drafts without summaries when the PR cache cannot be created", needsJq, () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: plain work (#7)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, { 7: whatChanged("Should not appear") });
  writeFileSync(join(dir, "fake-bin", "mktemp"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.equal(gh.calls().length, 0);
  assert.match(body, /- feat: plain work \(#7\)\n/);
  assert.doesNotMatch(body, /Should not appear/);
});

test("skeleton stays clean when enrichment is unavailable", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: plain work (#7)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, {}, { unavailable: true });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], gh.env);

  assert.match(body, /- feat: plain work \(#7\)\n/);
  assert.doesNotMatch(body, /  > /);
});

test("does not call gh when enrichment is disabled", () => {
  const dir = makeFixtureRepo();
  commit(dir, "feat: plain work (#7)");
  git(dir, "tag", "beta/v2026.100.0-beta.0");
  const gh = installFakeGh(dir, { 7: whatChanged("Should not appear") });

  const { body } = runDraft(dir, "2026.100.0-beta.0", [], {
    ...gh.env,
    DRAFT_NOTES_SKIP_PR_ENRICHMENT: "1",
  });

  assert.equal(gh.calls().length, 0);
  assert.doesNotMatch(body, /Should not appear/);
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
