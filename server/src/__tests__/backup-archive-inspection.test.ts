import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { c as createTarArchive, Header } from "tar";
import { inspectImportedArchive } from "../services/backup-archive.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("inspectImportedArchive", () => {
  it("accepts a regular backup bundle and returns its top-level directory", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-");
    const bundleName = "backup-20260309T120000Z-demo";
    const bundleDir = path.join(root, bundleName);
    await fs.mkdir(path.join(bundleDir, "database"), { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{\"id\":\"backup-1\"}\n", "utf8");
    await fs.writeFile(path.join(bundleDir, "database", "snapshot.sql"), "BEGIN;\nCOMMIT;\n", "utf8");

    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    await createTarArchive({ gzip: true, cwd: root, file: archivePath }, [bundleName]);

    const inspection = await inspectImportedArchive(archivePath);
    expect(inspection.bundleName).toBe(bundleName);
    expect(inspection.entryCount).toBeGreaterThan(0);
  });

  it("rejects an archive whose decompressed stream exceeds its inspection limit", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-size-");
    const bundleName = "backup-20260309T120000Z-size";
    const bundleDir = path.join(root, bundleName);
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "0".repeat(256 * 1024), "utf8");

    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    await createTarArchive({ gzip: true, cwd: root, file: archivePath }, [bundleName]);

    await expect(inspectImportedArchive(archivePath, { maxUncompressedBytes: 64 * 1024 })).rejects.toThrow(
      "Backup archive exceeds the maximum uncompressed size of 65536 bytes.",
    );
  });

  it("rejects an oversized declared entry before it can reach extraction", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-declared-size-");
    const bundleName = "backup-20260309T120000Z-declared-size";
    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    const header = Buffer.alloc(512);
    new Header({
      path: `${bundleName}/manifest.json`,
      type: "File",
      mode: 0o600,
      size: 256 * 1024,
      mtime: new Date(0),
    }).encode(header);
    await fs.writeFile(archivePath, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));

    await expect(inspectImportedArchive(archivePath, { maxUncompressedBytes: 64 * 1024 })).rejects.toThrow(
      "Backup archive exceeds the maximum uncompressed size of 65536 bytes.",
    );
  });

  it("rejects an archive with more entries than its inspection limit", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-entries-");
    const bundleName = "backup-20260309T120000Z-entries";
    const bundleDir = path.join(root, bundleName);
    await fs.mkdir(bundleDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n", "utf8"),
      fs.writeFile(path.join(bundleDir, "database.sql"), "BEGIN;\nCOMMIT;\n", "utf8"),
      fs.writeFile(path.join(bundleDir, "storage.txt"), "data\n", "utf8"),
    ]);

    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    await createTarArchive({ gzip: true, cwd: root, file: archivePath }, [bundleName]);

    await expect(inspectImportedArchive(archivePath, { maxEntries: 2 })).rejects.toThrow(
      "Backup archive contains more than 2 entries.",
    );
  });

  it("rejects backslash path separators before extraction", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-backslash-");
    const bundleName = "backup-20260309T120000Z-backslash";
    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    const header = Buffer.alloc(512);
    new Header({
      path: `${bundleName}/..\\..\\outside.txt`,
      type: "File",
      mode: 0o600,
      size: 0,
      mtime: new Date(0),
    }).encode(header);
    await fs.writeFile(archivePath, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));

    await expect(inspectImportedArchive(archivePath)).rejects.toThrow(
      "Backup archive contains a non-POSIX path separator.",
    );
  });

  it("rejects symbolic links before extraction", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-link-");
    const bundleName = "backup-20260309T120000Z-link";
    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    const header = Buffer.alloc(512);
    new Header({
      path: `${bundleName}/manifest.json`,
      type: "SymbolicLink",
      linkpath: "../outside.txt",
      mode: 0o777,
      size: 0,
      mtime: new Date(0),
    }).encode(header);
    await fs.writeFile(archivePath, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));

    await expect(inspectImportedArchive(archivePath)).rejects.toThrow(
      "Backup archive may only contain regular files and directories.",
    );
  });
});
