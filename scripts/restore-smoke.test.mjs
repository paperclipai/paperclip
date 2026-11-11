import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const opt of ["--db", "--volume", "--image", "--max-missing", "--max-torn", "--boot", "--boot-timeout", "--allow-unbound", "--keep"]) {
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

test("--boot points the server at the restored master key, not the source's saved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-smoke-"));
  try {
    const db = join(dir, "db.sql.gz");
    execFileSync("sh", ["-c", `printf 'select 1;\\n' | gzip > "${db}"`]);

    const home = join(dir, "src", "paperclip");
    const instance = join(home, "instances", "default");
    mkdirSync(join(instance, "secrets"), { recursive: true });
    mkdirSync(join(instance, "data", "run-logs"), { recursive: true });
    writeFileSync(join(instance, "secrets", "master.key"), "k".repeat(32));
    chmodSync(join(instance, "secrets", "master.key"), 0o600);
    writeFileSync(
      join(instance, "config.json"),
      JSON.stringify({ secrets: { localEncrypted: { keyFilePath: "/home/operator/.paperclip/instances/default/secrets/master.key" } } }),
    );
    const transcript = "{\"ts\":\"2026-01-01T00:00:00Z\"}\n";
    writeFileSync(join(instance, "data", "run-logs", "r1.ndjson"), transcript);
    const vol = join(dir, "vol.tar.gz");
    execFileSync("tar", ["-czf", vol, "-C", join(dir, "src"), "paperclip"]);

    const sha = createHash("sha256").update(transcript).digest("hex");
    const refsRow = ["r1.ndjson", "2026-01-01", String(Buffer.byteLength(transcript)), sha, ""].join("\t");
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    const dockerLog = join(dir, "docker.log");
    writeFileSync(join(fakeBin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *"select count(*) from company_secret_versions"*) echo 0 ;;
  *"select count(*) from heartbeat_runs"*) echo 1 ;;
  *"select log_ref"*) printf '%s\\n' "$REFS_ROW" ;;
  inspect*) echo false ;;
  "exec -i"*) cat >/dev/null ;;
esac
exit 0
`, { mode: 0o755 });

    const { status, out } = run(
      ["--db", db, "--volume", vol, "--allow-unbound", "--boot", "paperclip-image", "--boot-timeout", "1"],
      { PATH: fakeBin, DOCKER_LOG: dockerLog, REFS_ROW: refsRow },
    );
    assert.equal(status, 1, out);
    assert.match(out, /run-log check PASSED/);
    assert.match(out, /exited/);
    const appRun = readFileSync(dockerLog, "utf8").split("\n").find((line) => / --name restore-smoke-\d+-app /.test(line));
    assert.ok(appRun, `no app container start in:\n${readFileSync(dockerLog, "utf8")}`);
    assert.match(appRun, /PAPERCLIP_SECRETS_MASTER_KEY_FILE=\/paperclip\/instances\/default\/secrets\/master\.key( |$)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
