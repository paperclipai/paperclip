import { existsSync, mkdirSync, statSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { baseImg } from "./lib.ts";

const SYSTEM_CA = process.env.PKST_SYSTEM_CA ?? "/etc/ssl/certs/ca-certificates.crt";
const CHANNEL = process.env.PKST_NOBLE_CHANNEL ?? "current";
const IMAGE_NAME = "noble-server-cloudimg-amd64.img";
const BASE_URL = process.env.PKST_BASE_URL ?? `https://cloud-images.ubuntu.com/noble/${CHANNEL}`;
const PINNED_SHA = process.env.PKST_BASE_SHA256 ?? "";
const MIN_BYTES = 100 * 1024 * 1024;

function die(msg: string): never {
  console.error(`setup-base: ${msg}`);
  process.exit(1);
}

function curlText(url: string): string {
  const r = spawnSync(
    "curl",
    ["-fsSL", "--proto", "=https", "--tlsv1.2", "--cacert", SYSTEM_CA, "--retry", "3", url],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if ((r.status ?? -1) !== 0) die(`fetch failed (${url}): ${r.stderr || r.stdout}`);
  return r.stdout ?? "";
}

function curlDownload(url: string, outPath: string) {
  const r = spawnSync(
    "curl",
    ["-fSL", "--proto", "=https", "--tlsv1.2", "--cacert", SYSTEM_CA, "--retry", "3", "-o", outPath, url],
    { encoding: "utf8", timeout: 1_800_000 },
  );
  if ((r.status ?? -1) !== 0) die(`download failed (${url}): ${r.stderr || r.stdout}`);
}

function sha256Of(path: string): string {
  const r = spawnSync("openssl", ["dgst", "-sha256", "-r", path], { encoding: "utf8", timeout: 600_000 });
  if ((r.status ?? -1) !== 0) die(`sha256 failed (${path}): ${r.stderr || r.stdout}`);
  const first = (r.stdout ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(first)) die(`unexpected sha256 output for ${path}: ${r.stdout}`);
  return first;
}

function expectedSha(): string {
  if (PINNED_SHA) {
    if (!/^[0-9a-f]{64}$/.test(PINNED_SHA)) die(`PKST_BASE_SHA256 is not a 64-hex digest`);
    return PINNED_SHA;
  }
  const sums = curlText(`${BASE_URL}/SHA256SUMS`);
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+[*]?(.+)$/);
    if (m && m[2] === IMAGE_NAME) return m[1];
  }
  die(`no SHA256SUMS entry for ${IMAGE_NAME} at ${BASE_URL}/SHA256SUMS`);
}

function main() {
  const dest = baseImg();
  mkdirSync(dirname(dest), { recursive: true });

  const want = expectedSha();

  if (existsSync(dest)) {
    const bytes = statSync(dest).size;
    if (bytes >= MIN_BYTES && sha256Of(dest) === want) {
      console.log(JSON.stringify({ ok: true, path: dest, bytes, sha256: want, cached: true }, null, 2));
      return;
    }
  }

  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.part`;
  process.on("exit", () => {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {}
  });

  const haveExisting = existsSync(dest);
  const keptNote = haveExisting ? "; existing cached image left untouched" : "";

  curlDownload(`${BASE_URL}/${IMAGE_NAME}`, tmp);

  const bytes = statSync(tmp).size;
  if (bytes < MIN_BYTES) {
    die(`downloaded image is too small (${bytes} bytes); aborting${keptNote}`);
  }
  const got = sha256Of(tmp);
  if (got !== want) {
    die(`sha256 mismatch: got ${got}, expected ${want}${keptNote}`);
  }
  renameSync(tmp, dest);

  console.log(JSON.stringify({ ok: true, path: dest, bytes, sha256: want, cached: false }, null, 2));
}

main();
