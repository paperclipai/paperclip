import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isCompressedDatabaseBackupValid } from "./backup-integrity.js";

describe("compressed backup integrity", () => {
  it("rejects empty, truncated, and checksum-corrupt gzip files and rechecks changed files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-integrity-"));
    try {
      const file = path.join(dir, "backup.sql.gz");
      const complete = gzipSync("-- non-empty SQL dump\nSELECT 1;");
      fs.writeFileSync(file, complete);
      expect(await isCompressedDatabaseBackupValid(file)).toBe(true);
      const corrupt = Buffer.from(complete);
      corrupt[corrupt.length - 8] ^= 1;
      for (const bytes of [Buffer.alloc(0), gzipSync(""), complete.subarray(0, 20), corrupt]) {
        fs.writeFileSync(file, bytes);
        expect(await isCompressedDatabaseBackupValid(file)).toBe(false);
      }
      fs.writeFileSync(file, complete);
      expect(await isCompressedDatabaseBackupValid(file)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
