#!/usr/bin/env node
// ck-vault decrypt engine — runs INSIDE pc-build (has the master key + node).
// Reads JSON-per-line on stdin: {"name","description","material":{scheme,iv,tag,ciphertext}}
// Writes JSON-per-line on stdout: {"name","description","value"}
// The plaintext value never touches disk here; the caller decides where it goes.
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_PATH = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE || "/work/.pc-master.key";
const key = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
if (key.length !== 32) {
  console.error(`master key at ${KEY_PATH} is not 32 bytes (got ${key.length})`);
  process.exit(1);
}

function decrypt(m) {
  if (!m || m.scheme !== "local_encrypted_v1") {
    throw new Error(`unexpected material scheme: ${m && m.scheme}`);
  }
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(m.iv, "base64"));
  d.setAuthTag(Buffer.from(m.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(m.ciphertext, "base64")), d.final()]).toString("utf8");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const out = [];
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try { row = JSON.parse(s); } catch { console.error("skip unparseable line"); continue; }
    try {
      out.push(JSON.stringify({ name: row.name, description: row.description || "", value: decrypt(row.material) }));
    } catch (e) {
      console.error(`decrypt failed for ${row.name}: ${e.message}`);
      process.exitCode = 2;
    }
  }
  process.stdout.write(out.join("\n") + (out.length ? "\n" : ""));
});
