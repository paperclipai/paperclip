import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-node-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, content) => {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  };
  const sources = {
    ".nvmrc": "24\n",
    "packages/shared/src/node-version.ts": 'export const MINIMUM_NODE_VERSION = "24.11.0";\n',
    "scripts/install.sh": [
      'MIN_NODE_VERSION="${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}"',
      "MIN_NODE_MAJOR=24",
      "MIN_NODE_MINOR=11",
      "DEFAULT_NODE_MAJOR=24",
    ].join("\n"),
    "docker/agent-runtime/Dockerfile.base": "ARG NODE_VERSION=24\nFROM node:24-bookworm-slim\n",
    "packages/adapter-utils/src/sandbox-install-command.ts": 'NODE_VERSION="v24.11.0"\n',
    "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts": "nodesource.com/setup_24.x\n",
    "packages/plugins/sandbox-providers/modal/src/manifest.ts": 'default: "node:24"\n',
    "cli/esbuild.config.mjs": 'target: "node24"\n',
    "packages/plugins/sdk/src/bundlers.ts": 'target: "node24"\n',
    "scripts/generate-npm-package-json.mjs": 'engines: { node: ">=24.11.0" }\n',
  };
  for (const [filePath, content] of Object.entries(sources)) write(filePath, content);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const script of ["check-node-version-policy.mjs", "node-image-policy.mjs"]) {
    copyFileSync(new URL(script, import.meta.url), join(root, "scripts", script));
  }
  const manifest = (filePath, content) => write(filePath, JSON.stringify(content));
  manifest("package.json", { name: "node-policy-fixture", engines: { node: ">=24.11.0" } });
  manifest("packages/paperclip-runner/package.json", {
    name: "@paperclipai/paperclip-runner",
    engines: { node: ">=24.11.0" },
  });
  const run = () => {
    const result = spawnSync(process.execPath, [join(root, "scripts/check-node-version-policy.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  };
  return { manifest, run, write };
}

test("ignores a synthetic vendored Copilot manifest without engines.node", (t) => {
  const { manifest, run } = fixture(t);
  manifest("packages/paperclip-runner/provider-assets/copilot/darwin-arm64/distribution/package.json", {
    name: "synthetic-copilot-distribution",
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node version policy check passed/);
});

for (const [label, engines, expected] of [
  ["missing", undefined, "missing"],
  ["wrong", { node: ">=22.0.0" }, ">=22.0.0"],
]) {
  test(`rejects ${label} first-party engines.node`, (t) => {
    const { manifest, run } = fixture(t);
    manifest("packages/paperclip-runner/package.json", { name: "@paperclipai/paperclip-runner", engines });
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`${join("packages/paperclip-runner/package.json")}: engines.node must be >=24.11.0, found ${expected}`));
  });
}

for (const filePath of [
  "packages/other/provider-assets/package.json",
  "packages/paperclip-runner/src/provider-assets/package.json",
  "packages/paperclip-runner/provider-assets-other/package.json",
]) {
  test(`still validates unrelated ${filePath}`, (t) => {
    const { manifest, run } = fixture(t);
    manifest(filePath, { name: "first-party-fixture" });
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`${join(filePath)}: engines.node must be >=24.11.0, found missing`));
  });
}

test("still rejects first-party @types/node drift", (t) => {
  const { manifest, run } = fixture(t);
  manifest("packages/example/package.json", {
    engines: { node: ">=24.11.0" },
    devDependencies: { "@types/node": "^22.0.0" },
  });
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /devDependencies\.@types\/node must be \^24\.0\.0, found \^22\.0\.0/);
});

test("still rejects missing required source policy fragments", (t) => {
  const { run, write } = fixture(t);
  write(".nvmrc", "22\n");
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\.nvmrc: missing Node 24 policy fragment "24"/);
});
