import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CACHED_PATHS, HASHED_INPUTS, REQUIRED, RUNNER_PACKAGE, computeScope, markCurrent } from "../runner-release-crate-cache.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/runner-release-crate-cache.mjs");
const readWorkflow = (name) => readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
const prWorkflow = readWorkflow("pr-trusted.yml");
const releaseWorkflow = readWorkflow("release-verify.yml");

// Slice one job out of a workflow, from its two-space-indented key to the next.
function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `workflow is missing the ${name} job`);
  const body = workflow.slice(start + 1);
  const header = `  ${name}:\n`.length;
  const next = body.slice(header).search(/\n  [a-z0-9_-]+:\n/);
  return next === -1 ? body : body.slice(0, header + next + 1);
}

// Slice one step out of a job by its name, up to the next step.
function step(body, name) {
  const marker = `      - name: ${name}\n`;
  const start = body.indexOf(marker);
  assert.ok(start >= 0, `missing step: ${name}`);
  const rest = body.slice(start + marker.length);
  const next = rest.search(/\n      - name: /);
  return marker + (next === -1 ? rest : rest.slice(0, next + 1));
}

const RELEASE_DIR = `${RUNNER_PACKAGE}/runner/target/release`;
const KEY_STEP = "Compute the Runner release crate cache key";
const RESTORE_STEP = "Restore the Runner release crate (read only)";
const MARK_STEP = "Mark the restored Runner release crate current";
const LOOKUP_STEP = "Check for this push's Runner release crate";
const BUILD_STEP = "Build the Runner release crate for its cache";
const SAVE_STEP = "Save the Runner release crate";
const RUST_RESTORE_STEP = "Restore Runner Rust dependencies (read only)";

// Every PR job that builds the Runner release binary, and the command each
// one runs cargo through. The crate must be restored and marked before it.
const READERS = [
  ["typecheck_release_registry", "run: pnpm run typecheck:build-gaps"],
  ["verify_paperclip_runner", "run: pnpm --filter @paperclipai/paperclip-runner ${{ matrix.command }}"],
  ["build", "run: pnpm build"],
  ["canary_dry_run", "- name: Release canary dry run via release.sh internal build"],
];

const WRITER_GATE = "matrix.lane == 'rust' && github.repository == 'paperclipai/paperclip' && github.event_name == 'push' && github.ref == 'refs/heads/master' && inputs.ref == github.sha";

const expectedPathBlock = `          path: |\n${CACHED_PATHS.map((entry) => `            ${entry}\n`).join("")}`;
const expectedKey = `key: runner-release-crate-v1-\${{ steps.runner_release_crate_key.outputs.scope }}-\${{ hashFiles(${HASHED_INPUTS.map((entry) => `'${entry}'`).join(", ")}) }}`;

function assertCacheStep(body, name, { lookupOnly = false } = {}) {
  assert.match(body, /uses: actions\/cache\/(restore|save)@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/, name);
  assert.ok(body.includes(expectedPathBlock), `${name}: the cached path list must be exactly the script's CACHED_PATHS`);
  assert.ok(body.includes(expectedKey), `${name}: the key must be built from the script's scope and HASHED_INPUTS`);
  // An exact match or nothing: a prefix match would restore another
  // revision's artifacts and the mark step would make cargo keep them.
  assert.doesNotMatch(body, /restore-keys:/, name);
  assert.equal(/lookup-only: true/.test(body), lookupOnly, name);
  assert.doesNotMatch(body, /enableCrossOsArchive|fail-on-cache-miss: true/, name);
}

test("the script's path list and key inputs cover what the release build of the crate reads and writes", () => {
  assert.deepEqual(CACHED_PATHS, [
    `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*`,
    `${RELEASE_DIR}/deps/libpaperclip_runner_core-*`,
    `${RELEASE_DIR}/deps/paperclip_runner_core-*.d`,
    `${RELEASE_DIR}/deps/paperclip_runnerd-*`,
    `${RELEASE_DIR}/paperclip-runnerd`,
    `${RELEASE_DIR}/paperclip-runnerd.d`,
  ]);
  assert.deepEqual(HASHED_INPUTS, [
    `${RUNNER_PACKAGE}/rust-toolchain.toml`,
    `${RUNNER_PACKAGE}/runner/Cargo.toml`,
    `${RUNNER_PACKAGE}/runner/Cargo.lock`,
    `${RUNNER_PACKAGE}/runner/crates/**`,
    `${RUNNER_PACKAGE}/protocol/**`,
    `${RUNNER_PACKAGE}/test-fixtures/**`,
    `${RUNNER_PACKAGE}/test/fixtures/**`,
    "tests/runner-e2e/fixtures/**",
  ]);
  for (const input of HASHED_INPUTS) {
    const fixed = input.replace(/\/\*\*$/, "");
    assert.ok(statSync(path.join(repoRoot, fixed)), `${input} must exist in the repository`);
  }
  // The stage step copies the uplifted binary; it has to be in the set.
  const stage = readFileSync(path.join(repoRoot, RUNNER_PACKAGE, "scripts/stage-runner-binary.mjs"), "utf8");
  assert.match(stage, /"runner", "target", "release", executable/);
  assert.ok(CACHED_PATHS.includes(`${RELEASE_DIR}/paperclip-runnerd`));
});

// Every `include_str!` / `include_bytes!` in one Rust source, with the path
// each one names. Three argument forms are resolved: a string literal
// (relative to the source file), and `concat!(...)` of string literals,
// `env!("CARGO_MANIFEST_DIR")` (the directory of the nearest Cargo.toml) and
// macro metavariables (`$name`, which make the resolved path a directory
// prefix rather than a file). Anything else is reported as unsupported, so
// a new include form cannot slip past the guard by not matching a regex.
function crateIncludes(source, text) {
  const includes = [];
  for (const match of text.matchAll(/include_(?:str|bytes)!\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let inString = false;
    let end = start;
    for (; end < text.length && depth > 0; end += 1) {
      const ch = text[end];
      if (inString) {
        if (ch === "\\") end += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    assert.equal(depth, 0, `${source}: unbalanced include at offset ${match.index}`);
    const argument = text.slice(start, end - 1).trim();
    includes.push({ argument, ...resolveIncludeArgument(source, argument) });
  }
  return includes;
}

function manifestDir(source) {
  let dir = path.dirname(source);
  while (!statSync(path.join(dir, "Cargo.toml"), { throwIfNoEntry: false })?.isFile()) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `${source}: no Cargo.toml above the source`);
    dir = parent;
  }
  return dir;
}

function resolveIncludeArgument(source, argument) {
  const literal = argument.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (literal) return { form: "literal", resolved: path.resolve(path.dirname(source), literal[1]), exact: true };

  const concat = argument.match(/^concat!\s*\(([\s\S]*)\)$/);
  assert.ok(concat, `${source}: unsupported include form: ${argument}`);
  const parts = splitTopLevel(concat[1]);
  // A relative path is joined to the source's directory; one that starts
  // with the manifest directory is one string, since its next literal
  // starts with the "/" that separates the two.
  let base = `${path.dirname(source)}/`;
  let text = "";
  let exact = true;
  let form = "concat";
  for (const [index, part] of parts.entries()) {
    const string = part.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (string) {
      assert.ok(exact || !/(^|\/)\.\.(\/|$)/.test(string[1]), `${source}: a path segment after a metavariable must not climb out: ${argument}`);
      if (exact) text += string[1];
      continue;
    }
    if (part === 'env!("CARGO_MANIFEST_DIR")') {
      assert.equal(index, 0, `${source}: env!("CARGO_MANIFEST_DIR") must be the first part of concat!: ${argument}`);
      base = manifestDir(source);
      form = "concat-manifest-dir";
      continue;
    }
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      // The fixed prefix before the first metavariable is the directory the
      // macro's callers can reach; the suffix cannot climb out of it.
      exact = false;
      form = form === "concat-manifest-dir" ? form : "concat-metavariable";
      continue;
    }
    assert.fail(`${source}: unsupported concat! part in include: ${part}`);
  }
  const joined = base + text;
  const resolved = path.resolve(exact || text.endsWith("/") ? joined : path.dirname(joined));
  return { form, resolved, exact };
}

// Split concat!'s arguments on the commas outside string literals.
function splitTopLevel(text) {
  const parts = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      current += ch;
      if (ch === "\\") current += text[++index] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      current += ch;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const underHashedInputs = (resolved) =>
  HASHED_INPUTS.map((input) => path.join(repoRoot, input.replace(/\/\*\*$/, ""))).some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));

test("the include parser resolves literals, concat! with the manifest directory and with metavariables, and rejects other forms", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-includes-"));
  try {
    const crate = path.join(root, "crates/demo");
    mkdirSync(path.join(crate, "src/nested"), { recursive: true });
    mkdirSync(path.join(root, "protocol/fixtures"), { recursive: true });
    writeFileSync(path.join(crate, "Cargo.toml"), '[package]\nname = "demo"\n');
    writeFileSync(path.join(root, "protocol/schema.json"), "{}");
    const source = path.join(crate, "src/nested/mod.rs");
    const text = [
      'let a = include_str!("../../../../protocol/schema.json");',
      'let b = include_bytes!(\n    "../../../../protocol/schema.json"\n);',
      'let c = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../protocol/", "schema.json"));',
      'let d = include_str!(concat!("../../../../protocol/fixtures/", $fixture, ".json"));',
      'let e = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../protocol/fixtures/", $golden, ".summary.json"));',
      'let f = include_str!("a (paren) in the name.json");',
    ].join("\n");
    const includes = crateIncludes(source, text);
    assert.deepEqual(
      includes.map(({ form, resolved, exact }) => [form, path.relative(root, resolved), exact]),
      [
        ["literal", "protocol/schema.json", true],
        ["literal", "protocol/schema.json", true],
        ["concat-manifest-dir", "protocol/schema.json", true],
        ["concat-metavariable", "protocol/fixtures", false],
        ["concat-manifest-dir", "protocol/fixtures", false],
        ["literal", "crates/demo/src/nested/a (paren) in the name.json", true],
      ],
    );

    const rejected = [
      'include_str!(concat!("../protocol/", $x, "/../../../outside.json"))',
      'include_str!(concat!("../protocol/", env!("CARGO_MANIFEST_DIR")))',
      'include_str!(concat!(env!("OTHER_DIR"), "/schema.json"))',
      'include_str!(r"../protocol/schema.json")',
      'include_str!(path_from_a_function())',
      'include_str!(concat!("../protocol/", some_macro!("x")))',
    ];
    for (const argument of rejected) {
      assert.throws(() => crateIncludes(source, argument), /unsupported|must not climb out|must be the first part/, argument);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every file the crate includes by path sits under a hashed input, so an edit to it changes the key", () => {
  const crateRoot = path.join(repoRoot, RUNNER_PACKAGE, "runner/crates");
  const sources = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) sources.push(full);
    }
  })(crateRoot);
  assert.ok(sources.length > 10, "the crate sources must be found");
  const forms = new Set();
  let includes = 0;
  for (const source of sources) {
    for (const { argument, form, resolved, exact } of crateIncludes(source, readFileSync(source, "utf8"))) {
      includes += 1;
      forms.add(form);
      const where = `${path.relative(repoRoot, source)} includes ${argument.replace(/\s+/g, " ")}`;
      assert.ok(underHashedInputs(resolved), `${where}, which resolves to ${path.relative(repoRoot, resolved)}, outside every HASHED_INPUTS pattern`);
      const info = statSync(resolved, { throwIfNoEntry: false });
      assert.ok(exact ? info?.isFile() : info?.isDirectory(), `${where}: ${path.relative(repoRoot, resolved)} must exist`);
    }
  }
  assert.ok(includes > 0, "the crate includes protocol files by path; the guard must see them");
  // The crate uses every supported form today, so none of the parser's
  // branches is exercised only by the synthetic test above.
  assert.deepEqual([...forms].sort(), ["concat-manifest-dir", "concat-metavariable", "literal"]);
});

test("every PR reader restores the crate after the dependency cache and marks it before building", () => {
  for (const [name, buildCommand] of READERS) {
    const body = job(prWorkflow, name);
    const positions = [RUST_RESTORE_STEP, KEY_STEP, RESTORE_STEP, MARK_STEP].map((stepName) => body.indexOf(`      - name: ${stepName}\n`));
    assert.ok(positions.every((position) => position >= 0), `${name}: a crate cache step is missing`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${name}: the crate steps must follow the dependency restore in order`);
    const build = body.indexOf(buildCommand);
    assert.ok(build > positions.at(-1), `${name}: the crate must be marked before ${buildCommand}`);

    const key = step(body, KEY_STEP);
    assert.match(key, /id: runner_release_crate_key\n/, name);
    assert.match(key, /run: echo "scope=\$\(node scripts\/runner-release-crate-cache\.mjs scope\)" >> "\$GITHUB_OUTPUT"/, name);

    const restore = step(body, RESTORE_STEP);
    assert.match(restore, /id: runner_release_crate\n/, name);
    assertCacheStep(restore, `${name} restore`);
    assert.doesNotMatch(restore, /actions\/cache\/save/, name);

    const mark = step(body, MARK_STEP);
    assert.match(mark, /if: \$\{\{ steps\.runner_release_crate\.outputs\.cache-hit == 'true' \}\}/, name);
    assert.match(mark, /run: node scripts\/runner-release-crate-cache\.mjs mark-current/, name);
  }
  // No other job restores or saves the crate.
  const total = prWorkflow.match(/- name: Restore the Runner release crate \(read only\)\n/g)?.length ?? 0;
  assert.equal(total, READERS.length);
  assert.doesNotMatch(prWorkflow, /actions\/cache\/save@/);
});

test("the Verify Paperclip Runner job restores the crate only in the lanes that build it", () => {
  const body = job(prWorkflow, "verify_paperclip_runner");
  const lanes = [...body.matchAll(/- lane_label: (.+)\n\s+command: (.+)\n(\s+release_crate: (true)\n)?/g)].map(([, label, , , flag]) => [label, flag === "true"]);
  assert.deepEqual(lanes, [
    ["static checks", false],
    ["rust", true],
    ["vitest 1/2", false],
    ["vitest 2/2", true],
  ]);
  for (const stepName of [KEY_STEP, RESTORE_STEP]) {
    assert.match(step(body, stepName), /if: \$\{\{ matrix\.release_crate == true \}\}/, stepName);
  }
  // A lane that skipped the restore has no cache-hit output, so the mark
  // step's own condition is enough there.
  assert.match(step(body, MARK_STEP), /if: \$\{\{ steps\.runner_release_crate\.outputs\.cache-hit == 'true' \}\}/);
  for (const [name] of READERS.filter(([name]) => name !== "verify_paperclip_runner")) {
    for (const stepName of [KEY_STEP, RESTORE_STEP]) {
      assert.doesNotMatch(step(job(prWorkflow, name), stepName), /^\s+if:/m, `${name}: ${stepName} is unconditional`);
    }
  }
});

test("only the master Rust lane writes the crate, after a lookup, with the readers' exact path list and key", () => {
  const body = job(releaseWorkflow, "verify_paperclip_runner");
  const positions = ["Verify Paperclip Runner", "Warm debug dependencies for the shared Runner cache", KEY_STEP, LOOKUP_STEP, BUILD_STEP, SAVE_STEP].map((stepName) => body.indexOf(`      - name: ${stepName}\n`));
  assert.ok(positions.every((position) => position >= 0), "a writer step is missing");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the writer steps must follow the checks and the debug warm-up, in order");

  for (const stepName of [KEY_STEP, LOOKUP_STEP]) {
    assert.match(step(body, stepName), new RegExp(`if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\}\\}`), stepName);
  }
  for (const stepName of [BUILD_STEP, SAVE_STEP]) {
    assert.match(
      step(body, stepName),
      new RegExp(`if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && steps\\.runner_release_crate\\.outputs\\.cache-hit != 'true' \\}\\}`),
      stepName,
    );
  }
  assert.match(step(body, KEY_STEP), /run: echo "scope=\$\(node scripts\/runner-release-crate-cache\.mjs scope\)" >> "\$GITHUB_OUTPUT"/);

  const lookup = step(body, LOOKUP_STEP);
  assert.match(lookup, /id: runner_release_crate\n/);
  assert.match(lookup, /uses: actions\/cache\/restore@/);
  assertCacheStep(lookup, "writer lookup", { lookupOnly: true });

  // The saved artifacts come from the readers' exact command, on a crate
  // cleaned of the test-profile variants the lane's checks built.
  const build = step(body, BUILD_STEP);
  assert.match(build, /working-directory: packages\/paperclip-runner\n/);
  assert.match(build, /set -euo pipefail\n\s+cargo clean --release --manifest-path runner\/Cargo\.toml -p paperclip-runner-core\n\s+pnpm build:binary\n/);
  const runnerScripts = JSON.parse(readFileSync(path.join(repoRoot, RUNNER_PACKAGE, "package.json"), "utf8")).scripts;
  assert.match(runnerScripts["build:binary"], /^cargo build --release --manifest-path runner\/Cargo\.toml --locked -p paperclip-runner-core --bin paperclip-runnerd && /);

  const save = step(body, SAVE_STEP);
  assert.match(save, /uses: actions\/cache\/save@/);
  assertCacheStep(save, "writer save");

  // The dependency cache's own writer gate is the same expression.
  assert.match(body, new RegExp(`save-if: \\$\\{\\{ ${WRITER_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\}\\}`));
  assert.equal((releaseWorkflow.match(/actions\/cache\/save@/g) ?? []).length, 1);
});

test("the scope names the platform, the compiler and the checkout root, and survives a missing rustc", () => {
  const a = computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" });
  const b = computeScope({ workspace: "/home/runner/work/paperclip/paperclip", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" });
  const c = computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.2-0123456ab-x86_64-unknown-linux-gnu" });
  assert.notEqual(a, b, "a different checkout root must select a different entry");
  assert.notEqual(a, c, "a different compiler must select a different entry");
  assert.equal(a, computeScope({ workspace: "/home/runner/_work/paperclip/paperclip/", rustcVersion: "1.97.1-abcdef123-x86_64-unknown-linux-gnu" }));
  assert.match(a, new RegExp(`^${os.platform()}-${os.arch()}-1\\.97\\.1-abcdef123-x86_64-unknown-linux-gnu-[0-9a-f]{12}$`));
  assert.doesNotMatch(computeScope({ rustcVersion: "weird version/with spaces" }), /[^A-Za-z0-9._-]/);

  // The CLI reads rustc from PATH; a stand-in proves which fields it reads,
  // and an empty PATH proves a missing compiler still yields a usable key.
  const bin = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-rustc-"));
  try {
    const stub = path.join(bin, "rustc");
    writeFileSync(stub, '#!/bin/sh\nprintf "rustc 1.97.1 (8bab26f4f 2026-06-30)\\nbinary: rustc\\ncommit-hash: 8bab26f4f0123456789abcdef\\ncommit-date: 2026-06-30\\nhost: x86_64-unknown-linux-gnu\\nrelease: 1.97.1\\nLLVM version: 21.1.2\\n"\n');
    chmodSync(stub, 0o755);
    const withStub = execFileSync(process.execPath, [script, "scope"], { encoding: "utf8", env: { ...process.env, PATH: bin, GITHUB_WORKSPACE: "/home/runner/_work/paperclip/paperclip" } }).trim();
    assert.equal(withStub, computeScope({ workspace: "/home/runner/_work/paperclip/paperclip", rustcVersion: "1.97.1-8bab26f4f-x86_64-unknown-linux-gnu" }));
    const without = execFileSync(process.execPath, [script, "scope"], { encoding: "utf8", env: { ...process.env, PATH: mkdtempSync(path.join(os.tmpdir(), "empty-path-")), GITHUB_WORKSPACE: "/home/runner/_work/paperclip/paperclip" } }).trim();
    assert.match(without, /-no-rustc-/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// The tree cargo leaves behind for the crate's release lib and bin units,
// with the mtimes GitHub's cache restores: older than a fresh checkout.
function layRestoredCrate(root) {
  const release = path.join(root, RELEASE_DIR);
  const lib = path.join(release, ".fingerprint/paperclip-runner-core-0b6c4654c2710743");
  const bin = path.join(release, ".fingerprint/paperclip-runner-core-46cce78dbc4840c2");
  mkdirSync(path.join(release, "deps"), { recursive: true });
  mkdirSync(lib, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const files = {
    [path.join(lib, "lib-paperclip_runner_core")]: "0123456789abcdef",
    [path.join(lib, "lib-paperclip_runner_core.json")]: "{}",
    [path.join(lib, "dep-lib-paperclip_runner_core")]: "dep",
    [path.join(lib, "invoked.timestamp")]: "t",
    [path.join(bin, "bin-paperclip-runnerd")]: "fedcba9876543210",
    [path.join(bin, "bin-paperclip-runnerd.json")]: "{}",
    [path.join(bin, "dep-bin-paperclip-runnerd")]: "dep",
    [path.join(release, "deps/libpaperclip_runner_core-0b6c4654c2710743.rlib")]: "rlib",
    [path.join(release, "deps/libpaperclip_runner_core-0b6c4654c2710743.rmeta")]: "rmeta",
    [path.join(release, "deps/paperclip_runner_core-0b6c4654c2710743.d")]: "d",
    [path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2")]: "ELF",
    [path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2.d")]: "d",
    [path.join(release, "paperclip-runnerd")]: "ELF",
    [path.join(release, "paperclip-runnerd.d")]: "d",
    // A dependency's artifacts sit beside the crate's and must not be touched.
    [path.join(release, "deps/libserde-1234567890abcdef.rlib")]: "dep rlib",
  };
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(file, content);
    utimesSync(file, old, old);
  }
  for (const dir of [lib, bin, path.join(release, "deps"), path.join(release, ".fingerprint"), release]) utimesSync(dir, old, old);
  return { release, files: Object.keys(files), old };
}

test("mark-current makes every restored artifact newer than the checkout and leaves dependencies alone", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
  try {
    const { release, files, old } = layRestoredCrate(root);
    const checkout = path.join(root, RUNNER_PACKAGE, "runner/crates/runner-core/src/lib.rs");
    mkdirSync(path.dirname(checkout), { recursive: true });
    writeFileSync(checkout, "// checked out after the artifacts were built\n");
    const checkedOutAt = statSync(checkout).mtimeMs;

    const result = markCurrent({ root, now: new Date(checkedOutAt + 5000) });
    assert.equal(result.action, "marked");
    assert.equal(result.files, 14);
    assert.equal(result.bytes, files.filter((file) => !file.includes("libserde")).reduce((sum, file) => sum + statSync(file).size, 0));

    for (const file of files) {
      const mtime = statSync(file).mtimeMs;
      if (file.includes("libserde")) assert.equal(Math.floor(mtime / 1000), Math.floor(old.getTime() / 1000), "a dependency artifact must keep its mtime");
      else assert.ok(mtime > checkedOutAt, `${path.relative(release, file)} must be newer than the checkout`);
    }
    for (const dir of [".fingerprint/paperclip-runner-core-0b6c4654c2710743", ".fingerprint/paperclip-runner-core-46cce78dbc4840c2"]) {
      assert.ok(statSync(path.join(release, dir)).mtimeMs > checkedOutAt, `${dir} must be newer than the checkout`);
    }
    assert.ok(statSync(checkout).mtimeMs === checkedOutAt, "sources are never touched");

    // The CLI prints the same result as one line of JSON for the job log.
    const printed = JSON.parse(execFileSync(process.execPath, [script, "mark-current"], { encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root } }));
    assert.equal(printed.schema, "paperclip.runner-release-crate.v1");
    assert.equal(printed.action, "marked");
    assert.equal(printed.files, 14);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// One file per REQUIRED entry, as cargo 1.97.1 lays them out for the crate's
// release lib and bin units. Measured: without any one of these cargo
// recompiles the unit (the whole crate for a lib file, a relink for a bin
// file); without any of the files in NOT_NEEDED it reports the crate fresh
// and recreates the uplifted binary from the one under deps.
const REQUIRED_FILES = {
  "the lib fingerprint hash": ".fingerprint/paperclip-runner-core-0b6c4654c2710743/lib-paperclip_runner_core",
  "the lib dep-info": ".fingerprint/paperclip-runner-core-0b6c4654c2710743/dep-lib-paperclip_runner_core",
  "the lib rlib": "deps/libpaperclip_runner_core-0b6c4654c2710743.rlib",
  "the lib rmeta": "deps/libpaperclip_runner_core-0b6c4654c2710743.rmeta",
  "the bin fingerprint hash": ".fingerprint/paperclip-runner-core-46cce78dbc4840c2/bin-paperclip-runnerd",
  "the bin dep-info": ".fingerprint/paperclip-runner-core-46cce78dbc4840c2/dep-bin-paperclip-runnerd",
  "the bin under deps": "deps/paperclip_runnerd-46cce78dbc4840c2",
};
const NOT_NEEDED = [
  ".fingerprint/paperclip-runner-core-0b6c4654c2710743/lib-paperclip_runner_core.json",
  ".fingerprint/paperclip-runner-core-0b6c4654c2710743/invoked.timestamp",
  ".fingerprint/paperclip-runner-core-46cce78dbc4840c2/bin-paperclip-runnerd.json",
  "deps/paperclip_runner_core-0b6c4654c2710743.d",
  "deps/paperclip_runnerd-46cce78dbc4840c2.d",
  "paperclip-runnerd",
  "paperclip-runnerd.d",
];

test("mark-current discards a restore that lacks any file cargo needs for either unit, naming the file, so cargo sees a plain miss", () => {
  assert.deepEqual(REQUIRED.map(({ label }) => label), Object.keys(REQUIRED_FILES), "every REQUIRED entry has a missing-file case");
  for (const [label, file] of Object.entries(REQUIRED_FILES)) {
    const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
    try {
      const { release } = layRestoredCrate(root);
      rmSync(path.join(release, file));
      const result = markCurrent({ root });
      assert.equal(result.action, "discarded", `${file} missing must discard the restore`);
      assert.equal(result.reason, `incomplete: ${label} is missing`);
      assert.ok(result.removed > 0, label);
      assert.deepEqual(readdirSync(path.join(release, ".fingerprint")), [], label);
      assert.deepEqual(readdirSync(path.join(release, "deps")), ["libserde-1234567890abcdef.rlib"], `${label}: only the crate's own artifacts are removed`);
      assert.deepEqual(readdirSync(release).sort(), [".fingerprint", "deps"], label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // The bin's dep-info alone does not stand in for the bin: the glob that
  // finds the binary under deps must not be satisfied by the `.d` beside it.
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
  try {
    const { release } = layRestoredCrate(root);
    rmSync(path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2"));
    assert.ok(statSync(path.join(release, "deps/paperclip_runnerd-46cce78dbc4840c2.d")).isFile());
    assert.equal(markCurrent({ root }).reason, "incomplete: the bin under deps is missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // A file cargo neither reads nor checks for may be absent without costing
  // a rebuild, so its absence must not cost one here either.
  for (const file of NOT_NEEDED) {
    const intact = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-"));
    try {
      const { release } = layRestoredCrate(intact);
      rmSync(path.join(release, file));
      const result = markCurrent({ root: intact });
      assert.equal(result.action, "marked", `${file} missing must not discard the restore`);
      assert.equal(result.files, 13, file);
    } finally {
      rmSync(intact, { recursive: true, force: true });
    }
  }

  // Nothing restored at all is reported the same way and exits cleanly.
  const empty = mkdtempSync(path.join(os.tmpdir(), "runner-release-crate-empty-"));
  try {
    const printed = JSON.parse(execFileSync(process.execPath, [script, "mark-current"], { encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: empty } }));
    assert.equal(printed.action, "discarded");
    assert.equal(printed.reason, "incomplete: the lib fingerprint hash is missing");
    assert.equal(printed.removed, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the CLI prints the lists the workflows embed", () => {
  const paths = execFileSync(process.execPath, [script, "paths"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(paths, CACHED_PATHS);
  const inputs = execFileSync(process.execPath, [script, "hashed-inputs"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(inputs, HASHED_INPUTS);
  const usage = spawnSync(process.execPath, [script, "nonsense"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: runner-release-crate-cache\.mjs/);
});
