#!/usr/bin/env node
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const HELP = `restore-verify-secrets.mjs: prove that a restored master key is the key the
restored database's secrets were encrypted with.

Usage:
  restore-verify-secrets.mjs <master.key> --expect <n> < versions.tsv

Rows arrive on stdin, one per line, tab-separated:

  id <TAB> value_sha256 <TAB> material (the jsonb column as text)

  select id, value_sha256, material::text from company_secret_versions
   where material->>'scheme' = 'local_encrypted_v1'

Every local_encrypted_v1 version is decrypted with the key (AES-256-GCM, so a
wrong key cannot decrypt by accident), and the SHA-256 of the plaintext is
compared with the row's value_sha256. No plaintext is printed.

The key file holds 64 hex characters, base64 of 32 bytes, or 32 raw bytes, as
the server's local_encrypted provider accepts.

Options:
  <master.key>   the restored instances/<id>/secrets/master.key
  --expect <n>   the count(*) the database reported for the same query. Output
                 piped out of \`docker exec\` can arrive short with exit 0, so a
                 different row count fails before anything is decrypted
  -h, --help     print this help

Exits 0 when every version decrypts to its recorded hash, 1 when any does not
or the row count is off, 2 on a usage error.
`;

function usage(message) {
  if (message) console.error(message);
  console.error(HELP);
  process.exit(2);
}

const args = process.argv.slice(2);
let keyFile = null;
let expect = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-h" || args[i] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (args[i] === "--expect") {
    const value = args[i + 1];
    if (value === undefined || !/^[0-9]+$/.test(value)) usage(`--expect needs a non-negative integer, got: ${value}`);
    expect = Number(value);
    i += 1;
  } else if (keyFile === null && !args[i].startsWith("-")) {
    keyFile = args[i];
  } else {
    usage(`unknown argument: ${args[i]}`);
  }
}
if (keyFile === null || expect === null) usage();

function decodeMasterKey(raw) {
  const trimmed = raw.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32) return b64;
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

let key;
try {
  key = decodeMasterKey(readFileSync(keyFile, "utf8"));
} catch (err) {
  console.error(`FAIL: cannot read ${keyFile}: ${err.message}`);
  process.exit(1);
}
if (!key) {
  console.error(`FAIL: ${keyFile} is not a valid 32-byte key`);
  process.exit(1);
}

const rows = readFileSync(0, "utf8")
  .split("\n")
  .map((line) => line.replace(/\r$/, ""))
  .filter(Boolean);
if (rows.length !== expect) {
  console.error(`FAIL: ${rows.length} secret version(s) arrived, the database reported ${expect}.`);
  console.error("      The list was cut short (or padded) on its way here; nothing was checked.");
  process.exit(1);
}

const bad = [];
for (const row of rows) {
  const [id, want, material] = row.split("\t");
  try {
    const m = JSON.parse(material);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m.iv, "base64"));
    decipher.setAuthTag(Buffer.from(m.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(m.ciphertext, "base64")), decipher.final()]);
    const have = createHash("sha256").update(plain.toString("utf8")).digest("hex");
    if (have !== want) bad.push(`${id} (decrypts, but not to the recorded value_sha256)`);
  } catch (err) {
    bad.push(`${id} (${err.message})`);
  }
}

const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 12);
if (bad.length > 0) {
  console.error(`FAIL: ${bad.length} of ${rows.length} secret version(s) do not decrypt with ${keyFile} (fingerprint ${fingerprint}):`);
  for (const line of bad.slice(0, 20)) console.error(`  ${line}`);
  if (bad.length > 20) console.error("  ...");
  console.error("      The key and the dump are from different artifact sets. Every");
  console.error("      affected credential fails the first time an agent uses it.");
  process.exit(1);
}
console.log(
  `secrets check PASSED — ${rows.length} of ${rows.length} secret version(s) decrypt with the restored key (fingerprint ${fingerprint}) to their recorded value_sha256`,
);
