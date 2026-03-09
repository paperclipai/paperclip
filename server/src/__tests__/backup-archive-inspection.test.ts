import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { c as createTarArchive } from "tar";
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

  it("rejects symbolic links before extraction", async () => {
    const root = await makeTempRoot("paperclip-backup-archive-link-");
    const bundleName = "backup-20260309T120000Z-link";
    const bundleDir = path.join(root, bundleName);
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(root, "outside.txt"), "outside\n", "utf8");
    await fs.symlink("../outside.txt", path.join(bundleDir, "manifest.json"));

    const archivePath = path.join(root, `${bundleName}.tar.gz`);
    await createTarArchive({ gzip: true, cwd: root, file: archivePath }, [bundleName]);

    await expect(inspectImportedArchive(archivePath)).rejects.toThrow(
      "Backup archive may only contain regular files and directories.",
    );
  });
});
