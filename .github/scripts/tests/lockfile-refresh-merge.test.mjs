import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCKFILES } from "../lockfile-trust.mjs";

const workflow = readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url), "utf8");
const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
const step = (name) => {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  assert.ok(body, `the refresh workflow must have a "${name}" step`);
  return body;
};
const condition = (name) => step(name).match(/^        if: (.+)$/m)?.[1].trim();

test("the bot key is only reachable from the master-only lockfile-refresh environment", () => {
  assert.match(workflow, /^    environment: lockfile-refresh$/m);
  const keyUses = workflow.match(/secrets\.LOCKFILE_BOT_PRIVATE_KEY/g) ?? [];
  assert.equal(keyUses.length, 1, "only the token step may read the bot key");
  assert.match(step("Create lockfile bot token"), /private-key: \$\{\{ secrets\.LOCKFILE_BOT_PRIVATE_KEY \}\}/);
});

test("the bot token is minted only after resolution and the release-age gate", () => {
  const order = (name) => {
    const index = stepNames.indexOf(name);
    assert.notEqual(index, -1, `missing step "${name}"`);
    return index;
  };
  assert.ok(order("Refresh pnpm lockfile") < order("Check release age of added package versions"));
  assert.ok(order("Check release age of added package versions") < order("Create lockfile bot token"));
  assert.ok(order("Create lockfile bot token") < order("Merge lockfile PR"));
});

test("the gate runs only for an open PR, and the bot acts only when the gate passes", () => {
  assert.equal(condition("Check release age of added package versions"), "steps.upsert-pr.outputs.pr_url != ''");
  assert.equal(condition("Hold lockfile PR for review"), "steps.release-age.outputs.eligible == 'false'");
  assert.equal(condition("Create lockfile bot token"), "steps.release-age.outputs.eligible == 'true'");
  assert.equal(condition("Merge lockfile PR"), "steps.release-age.outputs.eligible == 'true'");
});

test("a held refresh keeps its versions through the next master run's artifact", () => {
  assert.ok(stepNames.indexOf("Reuse versions from a held refresh") < stepNames.indexOf("Refresh pnpm lockfile"));
  const reuse = step("Reuse versions from a held refresh");
  assert.match(reuse, /gh run list --workflow refresh-lockfile\.yml --branch master --status success/);
  assert.match(reuse, /gh run download "\$run_id" --name held-pnpm-lock/);
  assert.match(
    reuse,
    /if ! sha256sum --check --status "\$held\/source-locks\.sha256"; then[\s\S]*?exit 0\n          fi\n          for lock in \$LOCKFILES; do\n            cp "\$held\/\$lock" "\$lock"/,
    "held locks must only be reused while master still has every lock they were resolved from",
  );
  assert.match(reuse, /if \[ ! -f "\$held\/source-locks\.sha256" \]; then[\s\S]*?exit 0/, "an older held artifact must not be reused");
  assert.doesNotMatch(reuse, /chore\/refresh-lockfile/, "the PR branch is writable by others and must not seed resolution");

  for (const name of ["Stage held lockfile", "Save held lockfile for the next refresh"]) {
    assert.equal(condition(name), "steps.release-age.outputs.eligible == 'false'");
  }
  const stage = step("Stage held lockfile");
  assert.match(stage, /for lock in \$LOCKFILES; do[\s\S]*?cp "\$lock" "\$held\/\$lock"/);
  assert.match(stage, /\(cd "\$RUNNER_TEMP\/base-locks" && sha256sum \$LOCKFILES\) > "\$held\/source-locks\.sha256"/);
  const save = step("Save held lockfile for the next refresh");
  assert.match(save, /name: held-pnpm-lock/);
  assert.match(save, /path: \$\{\{ runner\.temp \}\}\/held-upload\//);
});

test("the bot merges only the commit this job pushed", () => {
  assert.match(step("Create or update pull request"), /echo "head_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  const merge = step("Merge lockfile PR");
  assert.match(merge, /HEAD_SHA: \$\{\{ steps\.upsert-pr\.outputs\.head_sha \}\}/);
  assert.match(merge, /GH_TOKEN: \$\{\{ steps\.bot-token\.outputs\.token \}\}/);
  assert.match(merge, /gh pr merge "\$PR_URL" .*--match-head-commit "\$HEAD_SHA"/);
});

test("a refresh that renews only the reporting-lock proof still opens a pull request", () => {
  const upsert = step("Create or update pull request");
  const check = upsert.match(/^          if (git diff --quiet -- [^;]+); then$/m)?.[1];
  assert.ok(check, "the PR step must check for changes with git diff --quiet");
  const added = upsert.match(/^          git add (.+)$/m)?.[1].split(" ");
  assert.deepEqual(check.replace("git diff --quiet -- ", "").split(" "), added, "the change check must cover every file the PR step commits");

  const root = mkdtempSync(path.join(tmpdir(), "refresh-proof-only-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root });
    execFileSync("mkdir", ["-p", path.join(root, "tests/runner-e2e")]);
    const files = { "pnpm-lock.yaml": "lock\n", "tests/runner-e2e/report-lock.json": "{}\n", "tests/runner-e2e/report-lock.patch": "old\n" };
    for (const [file, contents] of Object.entries(files)) writeFileSync(path.join(root, file), contents);
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const unchanged = () => spawnSync("bash", ["-c", check], { cwd: root }).status === 0;
    assert.equal(unchanged(), true);
    writeFileSync(path.join(root, "tests/runner-e2e/report-lock.json"), '{"outputSha256":"new"}\n');
    writeFileSync(path.join(root, "tests/runner-e2e/report-lock.patch"), "");
    assert.equal(unchanged(), false, "a proof-only change must not exit as unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the workflow owns the same lockfiles that the trust policy guards", () => {
  const env = workflow.match(/^      LOCKFILES: (.+)$/m)?.[1];
  assert.ok(env, "the refresh job must define LOCKFILES");
  assert.deepEqual(env.trim().split(/\s+/), LOCKFILES);
  assert.match(step("Refresh sandbox provider lockfiles"),
    /pnpm --dir scripts\/typecheck-sandbox-providers install --resolution-only --ignore-scripts --no-frozen-lockfile/);
  assert.match(step("Refresh sandbox provider lockfiles"),
    /pnpm --dir packages\/plugins\/sandbox-providers\/daytona install --ignore-workspace --resolution-only --ignore-scripts --no-frozen-lockfile/);
  assert.ok(stepNames.indexOf("Refresh sandbox provider lockfiles") < stepNames.indexOf("Fail on unexpected file changes"));
  assert.match(step("Check release age of added package versions"), /for lock in \$LOCKFILES; do[\s\S]*?pairs\+=\(--base "\$base\/\$lock" --head "\$lock"\)/);
});

// Run a workflow step's script with bash, as GitHub would.
const runStep = (name, cwd, env) => {
  const lines = step(name).split("\n");
  const start = lines.findIndex((line) => line === "        run: |") + 1;
  const script = lines.slice(start).map((line) => line.slice(10)).join("\n");
  return spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: { ...process.env, LOCKFILES: LOCKFILES.join(" "), ...env } });
};

test("unexpected-change check admits every managed lockfile and nothing else", () => {
  const root = mkdtempSync(path.join(tmpdir(), "refresh-unexpected-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root });
    for (const file of [...LOCKFILES, "notes.md"]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "old\n");
    }
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    for (const file of LOCKFILES) writeFileSync(path.join(root, file), "new\n");
    const allowed = runStep("Fail on unexpected file changes", root, {});
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    writeFileSync(path.join(root, "notes.md"), "new\n");
    const blocked = runStep("Fail on unexpected file changes", root, {});
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /notes\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held refresh round-trips every managed lockfile", () => {
  const root = mkdtempSync(path.join(tmpdir(), "refresh-held-"));
  const temp = mkdtempSync(path.join(tmpdir(), "refresh-held-temp-"));
  try {
    for (const file of LOCKFILES) {
      for (const dir of [root, path.join(temp, "base-locks")]) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), `master ${file}\n`);
      }
      writeFileSync(path.join(root, file), `held ${file}\n`);
    }
    const staged = runStep("Stage held lockfile", root, { RUNNER_TEMP: temp });
    assert.equal(staged.status, 0, staged.stderr);
    const held = path.join(temp, "held-upload");
    for (const file of LOCKFILES) assert.equal(readFileSync(path.join(held, file), "utf8"), `held ${file}\n`);

    // The next run checks the hashes against master's lockfiles, then copies the held ones in.
    for (const file of LOCKFILES) writeFileSync(path.join(root, file), `master ${file}\n`);
    const check = `sha256sum --check --status "${held}/source-locks.sha256"`;
    assert.equal(spawnSync("bash", ["-c", check], { cwd: root }).status, 0, "unchanged master locks must match the held source hashes");
    writeFileSync(path.join(root, LOCKFILES[1]), "changed on master\n");
    assert.notEqual(spawnSync("bash", ["-c", check], { cwd: root }).status, 0, "a changed provider lock must invalidate the held refresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
