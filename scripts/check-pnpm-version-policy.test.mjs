import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkPnpmVersionPolicy,
  checkTrackedPnpm9References,
  documentedPrerequisites,
  expectedPnpmVersion,
} from "./check-pnpm-version-policy.mjs";

const validWorkspace = `packages:
  - server

autoInstallPeers: false

patchedDependencies: # patch manifest
  "dependency@1.0.0": patches/dependency@1.0.0.patch # applied on install

allowBuilds:
  esbuild: true
  ssh2: false
`;

const validWorkflow = `jobs:
  ci:
    steps:
      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6
        with:
          version: ${expectedPnpmVersion}

      - name: Install
        run: pnpm install --frozen-lockfile
`;

// A repository that satisfies the policy; `files` overrides or removes
// (null) individual paths. `ignored` creates files that are git-ignored or untracked.
function createRepository(t, files = {}, ignored = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pnpm-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tracked = {
    "package.json": JSON.stringify({ name: "fixture", packageManager: `pnpm@${expectedPnpmVersion}` }),
    "pnpm-workspace.yaml": validWorkspace,
    "patches/dependency@1.0.0.patch": "patch\n",
    ".github/workflows/ci.yml": validWorkflow,
    "docker/daytona-runner/Dockerfile": `RUN corepack prepare pnpm@${expectedPnpmVersion} --activate\n`,
    ...Object.fromEntries(documentedPrerequisites.map(([docPath, snippet]) => [docPath, `Requires ${snippet}.\n`])),
    ...files,
  };
  for (const [relativePath, content] of Object.entries(tracked)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  for (const [relativePath, content] of Object.entries(ignored)) {
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), content);
  }
  return root;
}

test("accepts a repository that follows the pnpm 11 policy", (t) => {
  assert.deepEqual(checkPnpmVersionPolicy(createRepository(t), { runningVersion: expectedPnpmVersion }), []);
});

test("accepts a source tree exported without .git", (t) => {
  const root = createRepository(t);
  rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), []);
});

test("accepts a git checkout with an ignored file that mentions pnpm 9", (t) => {
  const root = createRepository(
    t,
    { ".gitignore": "ignored.md\ntest-results/\n" },
    {
      "ignored.md": "Mentions pnpm 9 in git-ignored file\n",
      "test-results/output.json": JSON.stringify({ note: "pnpm@9.15.4" }),
      "untracked.md": "Mentions pnpm 9 in untracked scratch notes\n",
    },
  );
  assert.deepEqual(checkTrackedPnpm9References(root), []);
  assert.deepEqual(
    checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion, scanTracked: true }),
    [],
  );
});

test("rejects a pnpm 9 package manager and a package.json#pnpm section", (t) => {
  const root = createRepository(t, {
    "package.json": JSON.stringify({ packageManager: "pnpm@9.15.4", pnpm: { overrides: {} } }),
  });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    `package.json: packageManager must be pnpm@${expectedPnpmVersion}, found pnpm@9.15.4`,
    "package.json: root package.json must not have a 'pnpm' configuration section; pnpm 11 requires pnpm-workspace.yaml authority",
  ]);
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion, scanTracked: true }), [
    `package.json: packageManager must be pnpm@${expectedPnpmVersion}, found pnpm@9.15.4`,
    "package.json: root package.json must not have a 'pnpm' configuration section; pnpm 11 requires pnpm-workspace.yaml authority",
    `package.json: references pnpm 9; the supported toolchain is pnpm@${expectedPnpmVersion}`,
  ]);
});

test("rejects a setup step pinned to another pnpm version", (t) => {
  const root = createRepository(t, {
    ".github/workflows/ci.yml": validWorkflow.replace(`version: ${expectedPnpmVersion}`, "version: 11.20.0"),
  });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    `.github/workflows/ci.yml:5: pnpm action-setup version must be ${expectedPnpmVersion}, found 11.20.0`,
  ]);
});

test("rejects a setup step without a version instead of reading the next step", (t) => {
  const root = createRepository(t, {
    ".github/workflows/ci.yml": `${validWorkflow.replace(`        with:\n          version: ${expectedPnpmVersion}\n`, "")}
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          version: ${expectedPnpmVersion}
`,
  });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    `.github/workflows/ci.yml:5: pnpm action-setup version must be ${expectedPnpmVersion}, found none`,
  ]);
});

test("requires autoInstallPeers to be false", (t) => {
  const root = createRepository(t, {
    "pnpm-workspace.yaml": validWorkspace.replace("autoInstallPeers: false", "autoInstallPeers: true"),
  });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    "pnpm-workspace.yaml: must set autoInstallPeers: false for deterministic resolution",
  ]);
});

test("requires explicit boolean build permissions", (t) => {
  const nonBoolean = createRepository(t, {
    "pnpm-workspace.yaml": validWorkspace.replace("esbuild: true", "esbuild: yes"),
  });
  assert.deepEqual(checkPnpmVersionPolicy(nonBoolean, { runningVersion: expectedPnpmVersion }), [
    "pnpm-workspace.yaml: allowBuilds entries must be package: true|false, found 'esbuild: yes'",
  ]);

  const missing = createRepository(t, {
    "pnpm-workspace.yaml": validWorkspace.slice(0, validWorkspace.indexOf("allowBuilds:")),
  });
  assert.deepEqual(checkPnpmVersionPolicy(missing, { runningVersion: expectedPnpmVersion }), [
    "pnpm-workspace.yaml: must declare explicit allowBuilds security policy",
  ]);
});

test("requires every declared patch to exist", (t) => {
  const root = createRepository(t, { "patches/dependency@1.0.0.patch": null });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    "pnpm-workspace.yaml: patch for dependency@1.0.0 does not exist: patches/dependency@1.0.0.patch",
  ]);
});

test("rejects a patch declaration it cannot parse", (t) => {
  const root = createRepository(t, {
    "pnpm-workspace.yaml": validWorkspace.replace(
      "patchedDependencies: # patch manifest\n",
      "patchedDependencies: # patch manifest\n  - not-a-mapping\n",
    ),
  });
  const failures = checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^pnpm-workspace\.yaml: Invalid patchedDependencies entry in .*: - not-a-mapping$/);
});

test("requires each documented prerequisite", (t) => {
  const [missingDoc] = documentedPrerequisites[0];
  const [staleDoc, staleSnippet] = documentedPrerequisites[1];
  const root = createRepository(t, { [missingDoc]: null, [staleDoc]: "Requires pnpm.\n" });
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion }), [
    `${missingDoc}: missing; it documents the pnpm prerequisite`,
    `${staleDoc}: must contain requirement documentation '${staleSnippet}'`,
  ]);
});

test("rejects tracked pnpm 9 references outside dated logs, plans, and generated directories", (t) => {
  const root = createRepository(
    t,
    {
      "docs/guide.md": "Install pnpm 9 first.\n",
      "doc/logs/2026-01-01-install.md": "The old shim ran pnpm add pnpm@9.15.4.\n",
      "doc/plans/2026-01-01-toolchain.md": "Move off pnpm 9.\n",
      "scripts/versions.json": JSON.stringify({ unrelated: "9.15.4" }),
    },
    {
      "notes/untracked.md": "pnpm 9 scratch notes\n",
      "test-results/ignored.json": JSON.stringify({ pnpm: "9.15.4" }),
    },
  );
  assert.deepEqual(checkTrackedPnpm9References(root), [
    `docs/guide.md: references pnpm 9; the supported toolchain is pnpm@${expectedPnpmVersion}`,
  ]);
  assert.deepEqual(
    checkPnpmVersionPolicy(root, { runningVersion: expectedPnpmVersion, scanTracked: true }),
    [`docs/guide.md: references pnpm 9; the supported toolchain is pnpm@${expectedPnpmVersion}`],
  );
});

test("fails when the running pnpm version differs from the pinned version", (t) => {
  const root = createRepository(t);
  assert.deepEqual(checkPnpmVersionPolicy(root, { runningVersion: "11.20.0" }), [
    `running pnpm version mismatch: expected ${expectedPnpmVersion}, found 11.20.0`,
  ]);
});
