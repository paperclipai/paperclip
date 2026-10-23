import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Behavioural tests for scripts/restore-verify-secrets.mjs: encrypt values
// exactly as the server's local_encrypted provider does, hand the rows a
// restored company_secret_versions would produce to the checker, and assert
// that only the key they were encrypted with passes.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "restore-verify-secrets.mjs");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Mirrors encryptValue() in server/src/secrets/local-encrypted-provider.ts.
function encrypt(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

const row = (id, key, value, recorded = sha256(value)) =>
  [id, recorded, JSON.stringify(encrypt(key, value))].join("\t");

function withKeyFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "restore-verify-secrets-"));
  try {
    const path = join(dir, "master.key");
    writeFileSync(path, contents, { mode: 0o600 });
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(keyPath, rows, args = ["--expect", String(rows.length)]) {
  const res = spawnSync(process.execPath, [scriptPath, keyPath, ...args], {
    input: rows.join("\n") + "\n",
    encoding: "utf8",
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

const KEY = randomBytes(32);
const OTHER = randomBytes(32);

test("the key the secrets were encrypted with passes, in every encoding the server accepts", () => {
  const rows = [row("v1", KEY, "sk-live-one"), row("v2", KEY, "ghp_two"), row("v3", KEY, "")];
  for (const encoded of [KEY.toString("base64"), KEY.toString("hex"), `${KEY.toString("base64")}\n`]) {
    withKeyFile(encoded, (path) => {
      const { status, out } = run(path, rows);
      assert.equal(status, 0, out);
      assert.match(out, /secrets check PASSED — 3 of 3 secret version\(s\) decrypt/);
      assert.doesNotMatch(out, /sk-live-one|ghp_two/, "plaintext must never be printed");
    });
  }
});

test("a valid key from a different artifact set fails", () => {
  // The case presence and mode cannot catch: a well-formed 32-byte key that
  // is simply not the one this dump's secrets were encrypted with.
  withKeyFile(OTHER.toString("base64"), (path) => {
    const { status, out } = run(path, [row("v1", KEY, "sk-live-one"), row("v2", KEY, "ghp_two")]);
    assert.equal(status, 1, out);
    assert.match(out, /FAIL: 2 of 2 secret version\(s\) do not decrypt/);
    assert.match(out, /v1 \(/);
    assert.doesNotMatch(out, /secrets check PASSED/);
  });
});

test("one version from another key fails the set", () => {
  withKeyFile(KEY.toString("base64"), (path) => {
    const { status, out } = run(path, [row("v1", KEY, "a"), row("stray", OTHER, "b")]);
    assert.equal(status, 1, out);
    assert.match(out, /FAIL: 1 of 2/);
    assert.match(out, /stray \(/);
  });
});

test("a value that decrypts but not to its recorded hash fails", () => {
  withKeyFile(KEY.toString("base64"), (path) => {
    const { status, out } = run(path, [row("v1", KEY, "actual", sha256("recorded"))]);
    assert.equal(status, 1, out);
    assert.match(out, /v1 \(decrypts, but not to the recorded value_sha256\)/);
  });
});

test("a key file that is not a 32-byte key fails", () => {
  withKeyFile("too short", (path) => {
    const { status, out } = run(path, [row("v1", KEY, "a")]);
    assert.equal(status, 1, out);
    assert.match(out, /is not a valid 32-byte key/);
  });
});

test("--expect fails a short list and is required", () => {
  withKeyFile(KEY.toString("base64"), (path) => {
    const short = run(path, [row("v1", KEY, "a")], ["--expect", "2"]);
    assert.equal(short.status, 1, short.out);
    assert.match(short.out, /1 secret version\(s\) arrived, the database reported 2/);

    const missing = run(path, [row("v1", KEY, "a")], []);
    assert.equal(missing.status, 2, missing.out);

    const bad = run(path, [row("v1", KEY, "a")], ["--expect", "one"]);
    assert.equal(bad.status, 2, bad.out);
  });
});
