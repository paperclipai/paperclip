import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Argument-handling tests for scripts/restore-smoke.sh. The script's real
// work needs docker, a postgres image, a Paperclip image and multi-gigabyte
// artifacts, so what CI can assert is the part that decides whether that
// work starts at all: every refusal happens before a container exists, and
// the exit code distinguishes "you called it wrong" (2) from "the artifact is
// bad" (1). The end-to-end run is recorded in docs/deploy/backup-restore.md.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "restore-smoke.sh");

function run(args, env = {}) {
  const res = spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${env.PATH ?? ""}:${process.env.PATH}` },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

test("script parses", () => {
  execFileSync("bash", ["-n", scriptPath]);
});

test("no --db is a usage error, and the usage text names every option", () => {
  const { status, out } = run([]);
  assert.equal(status, 2, out);
  for (const opt of ["--db", "--volume", "--image", "--max-missing", "--max-torn", "--boot", "--boot-timeout", "--keep"]) {
    assert.match(out, new RegExp(`^#?\\s*${opt}\\b`, "m"), `usage text should list ${opt}`);
  }
});

test("a missing artifact fails before anything starts", () => {
  const { status, out } = run(["--db", "/nonexistent/db.sql.gz"]);
  assert.equal(status, 1, out);
  assert.match(out, /FAIL: no such file: \/nonexistent\/db\.sql\.gz/);
});

test("--boot without --volume is refused: a server cannot start without the tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-smoke-"));
  try {
    const db = join(dir, "db.sql.gz");
    writeFileSync(db, "");
    const { status, out } = run(["--db", db, "--boot", "ghcr.io/paperclipai/paperclip:latest"]);
    assert.equal(status, 2, out);
    assert.match(out, /--boot needs --volume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--boot-timeout must be a number of seconds", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-smoke-"));
  try {
    const db = join(dir, "db.sql.gz");
    const vol = join(dir, "vol.tar.gz");
    writeFileSync(db, "");
    writeFileSync(vol, "");
    const { status, out } = run(["--db", db, "--volume", vol, "--boot", "img", "--boot-timeout", "soon"]);
    assert.equal(status, 2, out);
    assert.match(out, /--boot-timeout must be a whole number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--max-torn must be a non-negative integer, refused before anything starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-smoke-"));
  try {
    const db = join(dir, "db.sql.gz");
    writeFileSync(db, "");
    const { status, out } = run(["--db", db, "--max-torn", "a few"]);
    assert.equal(status, 2, out);
    assert.match(out, /--max-torn needs a non-negative integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated artifact fails the integrity step, before docker is needed", () => {
  // The integrity check is the first step and must run before any container
  // starts, so a corrupt gzip is caught even on a host without docker: put a
  // `docker` on PATH that fails loudly if anything reaches it.
  const dir = mkdtempSync(join(tmpdir(), "restore-smoke-"));
  try {
    const db = join(dir, "db.sql.gz");
    writeFileSync(db, "this is not gzip");
    const fakeBin = join(dir, "bin");
    execFileSync("mkdir", ["-p", fakeBin]);
    writeFileSync(join(fakeBin, "docker"), "#!/bin/sh\necho 'docker reached' >&2\nexit 99\n", { mode: 0o755 });
    const { status, out } = run(["--db", db], { PATH: fakeBin });
    assert.equal(status, 1, out);
    assert.match(out, /not in gzip format|unexpected end of file/);
    assert.doesNotMatch(out, /docker reached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
