import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptFileOffThread, digestFileOffThread, encryptFileOffThread, fileCryptoPoolLoad, FILE_CRYPTO_WORKER_LIMIT } from "./file-crypto-pool.js";

const MIB = 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("file crypto pool", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-file-crypto-pool-test-")); });
  afterEach(async () => {
    expect(fileCryptoPoolLoad()).toEqual({ running: 0, waiting: 0 });
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name: string, bytes: Uint8Array) => { const file = path.join(root, name); await fs.writeFile(file, bytes); return file; };
  /** A file of zeros that takes no disk space and far longer to digest than any test waits. */
  const endless = async (name: string) => {
    const file = path.join(root, name), handle = await fs.open(file, "wx", 0o600);
    try { await handle.truncate(64 * 1024 * MIB); } finally { await handle.close(); }
    return file;
  };

  it("digests a whole file, an inclusive range and an open descriptor as a single-threaded digest would", async () => {
    const bytes = randomBytes(3 * MIB + 137), file = await write("source", bytes);
    expect(await digestFileOffThread({ file, algorithm: "sha256" })).toEqual({ hex: sha256(bytes), bytes: bytes.length });
    expect(await digestFileOffThread({ file, algorithm: "md5", start: MIB - 5, end: 2 * MIB + 8 })).toEqual({
      hex: createHash("md5").update(bytes.subarray(MIB - 5, 2 * MIB + 9)).digest("hex"), bytes: MIB + 14 });
    // A range that runs past the end of the file stops at the end, as a read stream does.
    expect(await digestFileOffThread({ file, algorithm: "sha256", start: bytes.length - 10, end: bytes.length + 99 })).toEqual({
      hex: sha256(bytes.subarray(bytes.length - 10)), bytes: 10 });
    const handle = await fs.open(file, "r");
    try {
      expect(await digestFileOffThread({ fd: handle.fd, algorithm: "sha256" })).toEqual({ hex: sha256(bytes), bytes: bytes.length });
      // The descriptor is still the caller's to use and close.
      expect((await handle.stat()).size).toBe(bytes.length);
    } finally { await handle.close(); }
    await expect(digestFileOffThread({ file: path.join(root, "missing"), algorithm: "sha256" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies exactly the digested bytes to a new owner-only file and never replaces an existing one", async () => {
    const bytes = randomBytes(2 * MIB + 3), file = await write("source", bytes), copyTo = path.join(root, "copy");
    expect(await digestFileOffThread({ file, algorithm: "sha256", copyTo })).toEqual({ hex: sha256(bytes), bytes: bytes.length });
    expect((await fs.readFile(copyTo)).equals(bytes)).toBe(true);
    expect((await fs.stat(copyTo)).mode & 0o777).toBe(0o600);
    await fs.writeFile(copyTo, "kept");
    await expect(digestFileOffThread({ file, algorithm: "sha256", copyTo })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(copyTo, "utf8")).toBe("kept");
  });

  it("stores prefix, ciphertext and tag, and reports the digests of the source and of everything stored", async () => {
    const bytes = randomBytes(2 * MIB + 77), source = await write("source", bytes), target = path.join(root, "sealed");
    const key = randomBytes(32), kept = Buffer.from(key), iv = randomBytes(12), aad = Buffer.from("bound identity"), prefix = Buffer.from("MAGIC\n");
    const sealed = await encryptFileOffThread({ source, target, prefix, key, iv, aad });
    const stored = await fs.readFile(target);
    expect(sealed).toEqual({ plaintextSha256: sha256(bytes), plaintextBytes: bytes.length, sha256: sha256(stored), byteSize: prefix.length + bytes.length + 16 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(stored.subarray(0, prefix.length).equals(prefix)).toBe(true);
    // The caller's key is not consumed: erasing it stays the caller's decision.
    expect(key.equals(kept)).toBe(true);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad); decipher.setAuthTag(stored.subarray(stored.length - 16));
    expect(Buffer.concat([decipher.update(stored.subarray(prefix.length, stored.length - 16)), decipher.final()]).equals(bytes)).toBe(true);
    await expect(encryptFileOffThread({ source, target, prefix, key, iv, aad })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await fs.readFile(target)).equals(stored)).toBe(true);
  });

  it("decrypts an authentic ciphertext and reports every one that does not authenticate", async () => {
    const bytes = randomBytes(MIB + 9), source = await write("source", bytes), sealedPath = path.join(root, "sealed");
    const key = randomBytes(32), iv = randomBytes(12), aad = Buffer.from("bound identity"), prefix = Buffer.from("MAGIC\n");
    await encryptFileOffThread({ source, target: sealedPath, prefix, key, iv, aad });
    const stored = await fs.readFile(sealedPath), authTag = stored.subarray(stored.length - 16);
    const open = (name: string, change: Partial<Parameters<typeof decryptFileOffThread>[0]> = {}) => decryptFileOffThread({
      source: sealedPath, target: path.join(root, name), start: prefix.length, end: stored.length - 16, key, iv, aad, authTag, ...change });
    expect(await open("opened")).toEqual({ authenticationFailure: undefined });
    expect((await fs.readFile(path.join(root, "opened"))).equals(bytes)).toBe(true);
    expect((await fs.stat(path.join(root, "opened"))).mode & 0o777).toBe(0o600);
    for (const [name, change] of [["other-key", { key: randomBytes(32) }], ["other-aad", { aad: Buffer.from("another identity") }],
      ["other-tag", { authTag: randomBytes(16) }]] as const) {
      expect(await open(name, change)).toEqual({ authenticationFailure: { message: expect.stringContaining("authenticate") } });
    }
    const damaged = Buffer.from(stored); damaged[prefix.length + 5]! ^= 1;
    const damagedPath = await write("damaged", damaged);
    expect(await open("from-damaged", { source: damagedPath })).toEqual({ authenticationFailure: { message: expect.stringContaining("authenticate") } });
    // A ciphertext cut short does not authenticate either.
    expect(await open("from-short", { source: await write("short", stored.subarray(0, stored.length - 40)) }))
      .toEqual({ authenticationFailure: { message: expect.stringContaining("authenticate") } });
  });

  it("runs a bounded number of jobs at once, keeps the rest waiting in order, and cancels each kind promptly", async () => {
    const source = await endless("endless");
    const jobs = Array.from({ length: FILE_CRYPTO_WORKER_LIMIT + 2 }, (_, index) => {
      // Only the last job, which never runs, is asked to write anything.
      const controller = new AbortController(), copyTo = path.join(root, `copy-${index}`);
      const outcome = digestFileOffThread({ file: source, algorithm: "md5", ...(index > FILE_CRYPTO_WORKER_LIMIT ? { copyTo } : {}) },
        controller.signal).then(() => "finished", error => error);
      return { controller, copyTo, outcome };
    });
    expect(fileCryptoPoolLoad()).toEqual({ running: FILE_CRYPTO_WORKER_LIMIT, waiting: 2 });
    // A waiting job is cancelled at once and never touches its files.
    const last = jobs.at(-1)!, reason = new Error("request cancelled");
    last.controller.abort(reason);
    expect(await last.outcome).toMatchObject({ name: "AbortError", cause: reason });
    expect(fileCryptoPoolLoad()).toEqual({ running: FILE_CRYPTO_WORKER_LIMIT, waiting: 1 });
    await expect(fs.access(last.copyTo)).rejects.toMatchObject({ code: "ENOENT" });
    // A running job stops between chunks, and its worker takes the next waiting job.
    jobs[0]!.controller.abort(reason);
    expect(await jobs[0]!.outcome).toMatchObject({ name: "AbortError", cause: reason });
    expect(fileCryptoPoolLoad()).toEqual({ running: FILE_CRYPTO_WORKER_LIMIT, waiting: 0 });
    for (const job of jobs.slice(1, -1)) job.controller.abort(reason);
    for (const job of jobs.slice(1, -1)) expect(await job.outcome).toMatchObject({ name: "AbortError" });
    // The workers survive a cancellation and take new work.
    const small = await write("small", Buffer.from("after cancellation"));
    expect((await digestFileOffThread({ file: small, algorithm: "sha256" })).hex).toBe(sha256(Buffer.from("after cancellation")));
  }, 60_000);

  it("does not start a job whose signal is already aborted", async () => {
    const source = await write("source", randomBytes(1024)), target = path.join(root, "sealed"), reason = new Error("already cancelled");
    const controller = new AbortController(); controller.abort(reason);
    await expect(encryptFileOffThread({ source, target, prefix: Buffer.alloc(0), key: randomBytes(32), iv: randomBytes(12), aad: Buffer.alloc(0) },
      controller.signal)).rejects.toMatchObject({ name: "AbortError", cause: reason });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
