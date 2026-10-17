import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readApiKeyFile } from "../client/api-key-file.js";

const roots: string[] = [];
function credential(contents: string | Buffer = "fixture-token\n", mode = 0o600): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-credential-"));
  roots.push(root);
  const file = path.join(root, "token");
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("protected API credential file", () => {
  it.each(["fixture-token", "fixture-token\n", "fixture-token\r\n"])("reads a token with supported termination %j", (contents) => {
    expect(readApiKeyFile(credential(contents))).toBe("fixture-token");
  });

  it.each([0o400, 0o440, 0o600, 0o640])("allows operator-managed mode %s", (mode) => {
    expect(readApiKeyFile(credential("fixture-token", mode))).toBe("fixture-token");
  });

  it.each([0o644, 0o660, 0o604, 0o601, 0o610, 0o700])("refuses unsafe permissions %s", (mode) => {
    expect(() => readApiKeyFile(credential("fixture-token", mode))).toThrow("CLI credential file");
  });

  it.each(["", "\n", "one\ntwo", "one\n\n", "one\rtwo", "one\0two", "one two", " token", "token ", "token\t", "\ufefftoken", "tøkén"])("refuses invalid token content %j", (contents) => {
    expect(() => readApiKeyFile(credential(contents))).toThrow("CLI credential file");
  });

  it("rejects invalid UTF-8 bytes", () => {
    expect(() => readApiKeyFile(credential(Buffer.from([0xc0, 0xaf])))).toThrow("CLI credential file");
  });

  it("allows the exact byte limit and rejects larger files", () => {
    expect(readApiKeyFile(credential("x".repeat(64 * 1024)))).toHaveLength(64 * 1024);
    expect(() => readApiKeyFile(credential("x".repeat(64 * 1024 + 1)))).toThrow("CLI credential file");
  });

  it("supports activation symlinks while validating their target", () => {
    const file = credential();
    const alias = `${file}-alias`;
    fs.symlinkSync(file, alias);
    expect(readApiKeyFile(alias)).toBe("fixture-token");
    fs.chmodSync(file, 0o644);
    expect(() => readApiKeyFile(alias)).toThrow("CLI credential file");
  });

  it("rejects relative paths, directories, missing paths, and store paths", () => {
    const file = credential();
    for (const invalid of ["", "relative", path.dirname(file), `${file}-missing`, "/dev/null", "/nix/store/credential"]) {
      expect(() => readApiKeyFile(invalid)).toThrow("CLI credential file");
    }
    vi.spyOn(fs, "realpathSync").mockReturnValue("/nix/store/resolved-credential");
    const open = vi.spyOn(fs, "openSync");
    expect(() => readApiKeyFile(file)).toThrow("CLI credential file");
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not wait for a FIFO writer (swapped at open: %s)", (swap) => {
    const file = credential();
    if (!swap) {
      fs.unlinkSync(file);
      execFileSync("mkfifo", [file]);
    }
    const moduleUrl = new URL("../client/api-key-file.ts", import.meta.url).href;
    const script = `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
      import { readApiKeyFile } from ${JSON.stringify(moduleUrl)};
      if (${swap}) {
        const open = fs.openSync;
        fs.openSync = (...args) => {
          fs.unlinkSync(process.argv[1]); execFileSync('mkfifo', [process.argv[1]]);
          return open(...args);
        };
      }
      try { readApiKeyFile(process.argv[1]); process.exitCode = 1; }
      catch (error) { if (!error.message.startsWith('CLI credential file')) throw error; }`;
    // A blocking open would hang the test runner; exercise it in a bounded child.
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script, file], { timeout: 3_000 })).not.toThrow();
  });

  it.each(["regular", "symlink"])("rejects a %s replacement between validation and open", (replacement) => {
    const file = credential();
    const other = credential("different-identity");
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((filename, flags, mode) => {
      fs.unlinkSync(file);
      if (replacement === "regular") fs.renameSync(other, file);
      if (replacement === "symlink") fs.symlinkSync(other, file);
      return open(filename, flags, mode);
    });
    const read = vi.spyOn(fs, "readSync");
    expect(() => readApiKeyFile(file)).toThrow("CLI credential file");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects another owner's file before opening", () => {
    const file = credential();
    const stats = fs.lstatSync(file, { bigint: true });
    vi.spyOn(fs, "lstatSync").mockReturnValue(Object.assign(stats, { uid: BigInt(process.geteuid!()) + 1n }));
    const open = vi.spyOn(fs, "openSync");
    expect(() => readApiKeyFile(file)).toThrow("CLI credential file");
    expect(open).not.toHaveBeenCalled();
  });

  it("handles short reads and closes its descriptor", () => {
    const file = credential();
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => (
      read(fd, buffer, offset, Math.min(length, 2), position)
    )) as typeof fs.readSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(readApiKeyFile(file)).toBe("fixture-token");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["growth", "rewrite", "permissions", "read-error"])("fails closed and releases the descriptor after %s", (change) => {
    const file = credential();
    const read = fs.readSync;
    let changed = false;
    const reads = vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (!changed) {
        changed = true;
        if (change === "growth") fs.appendFileSync(file, "x".repeat(128 * 1024));
        if (change === "rewrite") {
          fs.writeFileSync(file, "changed-token\n");
          fs.utimesSync(file, new Date(0), new Date(0));
        }
        if (change === "permissions") fs.chmodSync(file, 0o644);
        if (change === "read-error") throw new Error("sensitive-path-or-value");
      }
      return read(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readApiKeyFile(file)).toThrow(/^CLI credential file is missing, invalid, changed, or insufficiently protected$/);
    const fd = reads.mock.calls[0][0];
    expect(close).toHaveBeenCalledWith(fd);
    expect(() => fs.fstatSync(fd)).toThrow();
    if (change === "growth") expect(reads).toHaveBeenCalledTimes(1);
  });
});
