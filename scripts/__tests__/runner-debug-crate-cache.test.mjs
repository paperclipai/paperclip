import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { debugContract, debugKey } from "../runner-debug-crate-cache.mjs";
import { markCurrent } from "../runner-release-crate-cache.mjs";

const bins = [...readFileSync("packages/paperclip-runner/runner/crates/runner-core/Cargo.toml", "utf8")
  .matchAll(/\[\[bin\]\]\nname = "([^"]+)"/g)].map(match => match[1]);
const metadata = { workspace_members: ["core"], packages: [{ id: "core", name: "paperclip-runner-core",
  targets: bins.map(name => ({ name, kind: ["bin"] })) }] };

test("every debug binary must be complete before the restored units are marked fresh", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-debug-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = debugContract(root, metadata);
  assert.equal(contract.bins.length, bins.length);
  assert.ok(contract.bins.length >= 6);
  for (const item of contract.required) {
    const filename = path.join(root, item.glob.replaceAll("*", "0123456789abcdef"));
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "cached artifact");
  }
  const dependency = path.join(root, "packages/paperclip-runner/runner/target/debug/deps/libserde-123.rlib");
  writeFileSync(dependency, "dependency");
  const previous = statSync(dependency).mtimeMs;
  assert.equal(markCurrent({ root, ...contract }).action, "marked");
  assert.equal(statSync(dependency).mtimeMs, previous);
  const last = contract.required.at(-1);
  rmSync(path.join(root, last.glob.replaceAll("*", "0123456789abcdef")));
  const discarded = markCurrent({ root, ...contract });
  assert.equal(discarded.action, "discarded");
  assert.match(discarded.reason, new RegExp(last.label));
  assert.equal(readFileSync(dependency, "utf8"), "dependency");
  assert.throws(() => debugContract(root, { ...metadata, workspace_members: [] }), /Review/);
});

test("the process-table library is cached with the crate, and any other workspace member needs review", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-debug-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const table = { id: "table", name: "paperclip-process-table", targets: [{ name: "paperclip_process_table", kind: ["lib"] }] };
  const withTable = { workspace_members: ["core", "table"], packages: [...metadata.packages, table] };
  const contract = debugContract(root, withTable);
  assert.ok(contract.cachedPaths.some(entry => entry.endsWith("/deps/libpaperclip_process_table-*")));
  assert.ok(contract.required.some(item => item.label === "the process-table lib rlib"));
  for (const item of contract.required) {
    const filename = path.join(root, item.glob.replaceAll("*", "0123456789abcdef"));
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "cached artifact");
  }
  assert.equal(markCurrent({ root, ...contract }).action, "marked");
  rmSync(path.join(root, contract.required.find(item => item.label === "the process-table lib rlib").glob.replaceAll("*", "0123456789abcdef")));
  assert.match(markCurrent({ root, ...contract }).reason, /process-table lib rlib/);
  const tableWithBin = { ...table, targets: [...table.targets, { name: "probe", kind: ["bin"] }] };
  assert.throws(() => debugContract(root, { ...withTable, packages: [...metadata.packages, tableWithBin] }), /Review/);
  const other = { id: "other", name: "paperclip-other", targets: [{ name: "other", kind: ["lib"] }] };
  assert.throws(() => debugContract(root, { workspace_members: ["core", "other"], packages: [...metadata.packages, other] }), /Review/);
});

test("debug cache keys invalidate source, included inputs, deletions and compiler flags", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runner-debug-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "pub fn run() {}\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const env = { CARGO_HOME: path.join(root, "cargo-home") };
  const first = debugKey(root, env);
  assert.equal(debugKey(root, env), first);
  for (const name of ["RUST_LOG", "RUST_BACKTRACE", "RUSTUP_HOME"]) {
    assert.equal(debugKey(root, { ...env, [name]: "different-runner-value" }), first, name);
  }
  assert.notEqual(debugKey(root, { ...env, RUSTFLAGS: "-C target-cpu=native" }), first);
  assert.notEqual(debugKey(root, { ...env, RUSTC_WORKSPACE_WRAPPER: "/compiler-wrapper" }), first);
  writeFileSync(source, "pub fn run() { panic!(); }\n");
  assert.notEqual(debugKey(root, env), first);
  rmSync(source);
  assert.notEqual(debugKey(root, env), first);
  writeFileSync(source, "pub fn run() {}\n");
  const protocol = path.join(root, "packages/paperclip-runner/protocol/input.json");
  mkdirSync(path.dirname(protocol), { recursive: true });
  writeFileSync(protocol, "{}");
  execFileSync("git", ["add", "."], { cwd: root });
  assert.notEqual(debugKey(root, env), first);
});

test("PRs only restore exact debug keys and only verified master pushes publish them", () => {
  const pr = readFileSync(".github/workflows/pr-trusted.yml", "utf8");
  const release = readFileSync(".github/workflows/release-verify.yml", "utf8");
  const step = (source, name) => source.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  const reader = step(pr, "Restore the Runner debug crate (read only)");
  assert.match(reader, /actions\/cache\/restore@/);
  assert.match(reader, /hashFiles\('scripts\/runner-debug-crate-cache.mjs'\) != ''/);
  assert.doesNotMatch(reader, /restore-keys/);
  for (const field of ["key", "paths"]) assert.ok(reader.includes(`steps.runner_debug_crate_key.outputs.${field}`));
  assert.equal(step(pr, "Save the Runner debug crate"), undefined);
  for (const name of ["Compute the Runner debug crate cache key", "Check for this push's Runner debug crate",
    "Clean debug test variants before publishing workspace binaries", "Save the Runner debug crate"]) {
    const body = step(release, name);
    assert.match(body, /matrix.lane == 'rust' && github.repository == 'paperclipai\/paperclip' && github.event_name == 'push' && github.ref == 'refs\/heads\/master' && inputs.ref == github.sha/);
  }
  assert.match(step(release, "Save the Runner debug crate"), /runner_debug_crate.outputs.cache-hit != 'true'/);
  assert.match(step(release, "Warm debug dependencies for the shared Runner cache"), /build:rust/);
  assert.ok(release.indexOf("Warm debug dependencies") < release.indexOf("Save the Runner debug crate"));
});
