import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installer = path.join(repo, "scripts/install-claude-test-cli.sh");

function nodeScript(source, nodeExecutable = process.execPath) {
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return "#!/bin/sh\nexec " + quote(nodeExecutable) + " -e " + quote(source) + ' "$0" "$@"\n';
}

function fixture(version, quotedRuntime = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-ci-prerequisite-"));
  const fakeBin = path.join(root, "fake-bin");
  mkdirSync(fakeBin);
  const nodeExecutable = quotedRuntime ? path.join(root, "node with ' quotes") : process.execPath;
  if (quotedRuntime) symlinkSync(process.execPath, nodeExecutable);
  const npm = path.join(fakeBin, "npm");
  const npmSource = `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.TEST_INSTALL_ARGS, JSON.stringify(args));
const prefix = args[args.indexOf("--prefix") + 1];
const wrapper = path.join(prefix, "node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs");
fs.mkdirSync(path.dirname(wrapper), {recursive:true});
fs.writeFileSync(wrapper, ${JSON.stringify(nodeScript(`console.log(${JSON.stringify(version)});\n`, nodeExecutable))});
`;
  writeFileSync(npm, nodeScript(npmSource, nodeExecutable));
  chmodSync(npm, 0o755);
  const githubPath = path.join(root, "github-path");
  writeFileSync(githubPath, "");
  const argsPath = path.join(root, "args.json");
  const runnerTemp = path.join(root, "runner");
  const result = spawnSync("bash", [installer], {
    cwd: repo, encoding: "utf8",
    env: { PATH: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`, RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath, TEST_INSTALL_ARGS: argsPath },
  });
  return { root, runnerTemp, result, githubPath, args: JSON.parse(readFileSync(argsPath, "utf8")) };
}

test("pins the isolated CLI and publishes its path only after version verification", () => {
  const f = fixture("2.1.207 (Claude Code)");
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(f.args.includes("@anthropic-ai/claude-code@2.1.207"));
    assert.ok(f.args.includes("--ignore-scripts"));
    assert.ok(!f.args.includes("--global"));
    assert.equal(f.args[f.args.indexOf("--prefix") + 1], path.join(f.runnerTemp, "paperclip-claude-cli"));
    assert.equal(readFileSync(f.githubPath, "utf8"), `${path.join(f.runnerTemp, "paperclip-claude-bin")}\n`);
  } finally { rmSync(f.root, {recursive:true, force:true}); }
});

test("rejects an unexpected version without publishing its path", () => {
  const f = fixture("2.1.150 (Claude Code)");
  try {
    assert.notEqual(f.result.status, 0);
    assert.match(f.result.stderr, /Unexpected Claude CLI version/);
    assert.equal(readFileSync(f.githubPath, "utf8"), "");
  } finally { rmSync(f.root, {recursive:true, force:true}); }
});

test("PR and release workflows provision the CLI only for the MCP workspace lane", () => {
  for (const name of ["pr-trusted.yml", "release-verify.yml"]) {
    const source = readFileSync(path.join(repo, ".github/workflows", name), "utf8");
    const step = source.split("      - name: Install pinned Claude test CLI\n")[1]?.split(/\n(?=      - name:)/)[0];
    assert.ok(step, name);
    assert.match(step, /if: matrix.group == 'general-workspaces-b'/);
    assert.match(step, /run: bash scripts\/install-claude-test-cli\.sh/);
    assert.ok(source.indexOf("Install pinned Claude test CLI") < source.indexOf("Run grouped general test suites"));
  }
});

test("runs fake npm and Claude commands with a quoted Node path", () => {
  const f = fixture("2.1.207 (Claude Code)", true);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(readFileSync(f.githubPath, "utf8"), `${path.join(f.runnerTemp, "paperclip-claude-bin")}\n`);
  } finally { rmSync(f.root, {recursive:true, force:true}); }
});
