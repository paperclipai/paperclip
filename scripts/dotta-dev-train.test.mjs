import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "dotta-dev-train.sh");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    [
      `command failed: ${command} ${args.join(" ")}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n"),
  );
  return result.stdout;
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  assert.notEqual(
    result.status,
    0,
    `command unexpectedly succeeded: ${command} ${args.join(" ")}`,
  );
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).trim();
}

function write(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function createPullRequest(seed, origin, number, files) {
  git(seed, "switch", "--force-create", `pr-${number}`, "master");
  for (const [relativePath, contents] of Object.entries(files)) {
    write(seed, relativePath, contents);
  }
  git(seed, "add", ".");
  git(seed, "commit", "-m", `test PR ${number}`);
  const sha = git(seed, "rev-parse", "HEAD");
  git(seed, "push", origin, `${sha}:refs/pull/${number}/head`);
  return sha;
}

function installFakeGh(binDir) {
  mkdirSync(binDir, { recursive: true });
  const fakeGhPath = path.join(binDir, "gh");
  writeFileSync(
    fakeGhPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + "\\n");
const pullRequests = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));

if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(pullRequests.map(({ files, ...pullRequest }) => pullRequest)));
  process.exit(0);
}

if (args[0] === "api") {
  const endpoint = args.find((arg) => arg.startsWith("repos/"));
  const number = Number(endpoint?.match(/\\/pulls\\/(\\d+)\\/files/)?.[1]);
  const pullRequest = pullRequests.find((candidate) => candidate.number === number);
  if (!pullRequest) process.exit(1);
  process.stdout.write(pullRequest.files.join("\\n") + "\\n");
  process.exit(0);
}

process.stderr.write("unexpected gh call: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  chmodSync(fakeGhPath, 0o755);
}

test("builds an ordered train, flags migrations, skips conflicts, and keeps dry-run remote-only", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dotta-dev-train-test-"));

  try {
    const origin = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const workspace = path.join(root, "workspace");
    const fakeBin = path.join(root, "bin");
    const ghFixturePath = path.join(root, "pull-requests.json");
    const ghCallLogPath = path.join(root, "gh-calls.jsonl");
    const manifestRelativePath = "train-manifest.json";
    const manifestPath = path.join(workspace, manifestRelativePath);

    run("git", ["init", "--bare", "--initial-branch=master", origin]);
    run("git", ["init", "--initial-branch=master", seed]);
    git(seed, "config", "user.name", "Dotta train test");
    git(seed, "config", "user.email", "dotta-train-test@example.com");
    write(seed, "conflict.txt", "base\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "master");
    const baseMasterSha = git(seed, "rev-parse", "master");

    const pr2Sha = createPullRequest(seed, origin, 2, {
      "conflict.txt": "from PR 2\n",
      "feature-two.txt": "included\n",
    });
    const pr10Sha = createPullRequest(seed, origin, 10, {
      "packages/db/src/migrations/9999_dotta_train_test.sql": "select 1;\n",
    });
    const pr12Sha = createPullRequest(seed, origin, 12, {
      "conflict.txt": "from conflicting PR 12\n",
    });

    run("git", ["clone", origin, workspace]);
    git(workspace, "config", "user.name", "Dotta train test");
    git(workspace, "config", "user.email", "dotta-train-test@example.com");
    installFakeGh(fakeBin);

    const pullRequests = [
      {
        number: 10,
        headRefOid: pr10Sha,
        title: "Add a migration",
        files: ["packages/db/src/migrations/9999_dotta_train_test.sql"],
      },
      {
        number: 12,
        headRefOid: pr12Sha,
        title: "Conflict with PR 2",
        files: ["conflict.txt"],
      },
      {
        number: 2,
        headRefOid: pr2Sha,
        title: 'Add feature "two"',
        files: ["conflict.txt", "feature-two.txt"],
      },
    ];
    writeFileSync(ghFixturePath, JSON.stringify(pullRequests));
    writeFileSync(ghCallLogPath, "");

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GH_CALL_LOG: ghCallLogPath,
      GH_FIXTURE: ghFixturePath,
      TMPDIR: root,
    };

    writeFileSync(manifestPath, "operator-owned content\n");
    const occupiedManifestResult = runFailure(
      "bash",
      [scriptPath, "--manifest", manifestRelativePath],
      { cwd: workspace, env },
    );
    assert.match(
      occupiedManifestResult.stderr,
      /refusing to overwrite manifest path not generated by/,
    );
    assert.equal(readFileSync(manifestPath, "utf8"), "operator-owned content\n");
    rmSync(manifestPath);

    const trackedManifestRelativePath = "tracked-manifest.json";
    const trackedManifestPath = path.join(workspace, trackedManifestRelativePath);
    const previousManifest = JSON.stringify({
      schemaVersion: 1,
      generatedBy: "scripts/dotta-dev-train.sh",
      repository: "paperclipai/paperclip",
      branch: "dev/dotta",
    });
    writeFileSync(trackedManifestPath, `${previousManifest}\n`);
    git(workspace, "add", trackedManifestRelativePath);
    git(workspace, "commit", "-m", "add tracked manifest fixture");
    const trackedManifestResult = runFailure(
      "bash",
      [scriptPath, "--manifest", trackedManifestRelativePath],
      { cwd: workspace, env },
    );
    assert.match(
      trackedManifestResult.stderr,
      /refusing to overwrite tracked manifest path/,
    );
    assert.equal(readFileSync(trackedManifestPath, "utf8"), `${previousManifest}\n`);

    const absoluteTrackedManifestResult = runFailure(
      "bash",
      [scriptPath, "--manifest", trackedManifestPath],
      { cwd: workspace, env },
    );
    assert.match(
      absoluteTrackedManifestResult.stderr,
      /refusing to overwrite tracked manifest path/,
    );
    assert.equal(readFileSync(trackedManifestPath, "utf8"), `${previousManifest}\n`);
    git(workspace, "reset", "--hard", "origin/master");

    const normalOutput = run("bash", [scriptPath, "--manifest", manifestRelativePath], {
      cwd: workspace,
      env,
    });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.generatedBy, "scripts/dotta-dev-train.sh");
    assert.equal(manifest.baseMasterSha, baseMasterSha);
    assert.equal(manifest.dryRun, false);
    assert.deepEqual(
      manifest.included.map((pullRequest) => pullRequest.number),
      [2, 10],
    );
    assert.deepEqual(
      manifest.included.map((pullRequest) => pullRequest.migrations),
      [false, true],
    );
    assert.equal(manifest.included[0].title, 'Add feature "two"');
    assert.deepEqual(
      manifest.skipped.map((pullRequest) => pullRequest.number),
      [12],
    );
    assert.match(manifest.skipped[0].reason, /^merge conflict: conflict\.txt$/);
    assert.match(normalOutput, /Included \(2\):/);
    assert.match(normalOutput, /Skipped \(1\):/);

    assert.equal(readFileSync(path.join(workspace, "feature-two.txt"), "utf8"), "included\n");
    assert.equal(readFileSync(path.join(workspace, "conflict.txt"), "utf8"), "from PR 2\n");
    assert.equal(git(workspace, "status", "--porcelain"), `?? ${manifestRelativePath}`);

    const mergeOrder = git(
      workspace,
      "log",
      "--reverse",
      "--merges",
      "--format=%s",
      "origin/master..dev/dotta",
    ).split("\n");
    assert.deepEqual(mergeOrder, ["dotta-dev: merge PR #2", "dotta-dev: merge PR #10"]);

    const pushedTrainSha = git(origin, "rev-parse", "refs/heads/dev/dotta");
    assert.equal(pushedTrainSha, git(workspace, "rev-parse", "dev/dotta"));
    const normalGhCalls = readFileSync(ghCallLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(normalGhCalls.some((args) => args[0] === "label" && args[1] === "create"));
    const normalPrListCall = normalGhCalls.find(
      (args) => args[0] === "pr" && args[1] === "list",
    );
    assert.ok(normalPrListCall);
    assert.equal(normalPrListCall[normalPrListCall.indexOf("--base") + 1], "master");

    const pr14Sha = createPullRequest(seed, origin, 14, {
      "dry-run-only.txt": "must not reach the remote train\n",
    });
    pullRequests.push({
      number: 14,
      headRefOid: pr14Sha,
      title: "Dry-run-only change",
      files: ["dry-run-only.txt"],
    });
    writeFileSync(ghFixturePath, JSON.stringify(pullRequests));
    writeFileSync(ghCallLogPath, "");

    const dryRunOutput = run(
      "bash",
      [scriptPath, "--dry-run", "--manifest", manifestRelativePath],
      { cwd: workspace, env },
    );
    const dryRunManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    assert.equal(dryRunManifest.dryRun, true);
    assert.deepEqual(
      dryRunManifest.included.map((pullRequest) => pullRequest.number),
      [2, 10, 14],
    );
    assert.equal(readFileSync(path.join(workspace, "dry-run-only.txt"), "utf8"), "must not reach the remote train\n");
    assert.equal(git(origin, "rev-parse", "refs/heads/dev/dotta"), pushedTrainSha);
    assert.match(dryRunOutput, /did not push dev\/dotta/);

    const dryRunGhCalls = readFileSync(ghCallLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(!dryRunGhCalls.some((args) => args[0] === "label"));

    rmSync(manifestPath);
    const pr16Sha = createPullRequest(seed, origin, 16, {
      [manifestRelativePath]: "content from PR 16\n",
    });
    pullRequests.push({
      number: 16,
      headRefOid: pr16Sha,
      title: "Add the manifest destination",
      files: [manifestRelativePath],
    });
    writeFileSync(ghFixturePath, JSON.stringify(pullRequests));

    const introducedManifestResult = runFailure(
      "bash",
      [scriptPath, "--manifest", manifestRelativePath],
      { cwd: workspace, env },
    );
    assert.match(
      introducedManifestResult.stderr,
      /refusing to overwrite tracked manifest path introduced while assembling/,
    );
    assert.equal(readFileSync(manifestPath, "utf8"), "content from PR 16\n");
    assert.equal(git(origin, "rev-parse", "refs/heads/dev/dotta"), pushedTrainSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
