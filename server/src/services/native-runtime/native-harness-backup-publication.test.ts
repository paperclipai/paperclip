import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { publishNativeHarnessBackup } from "./native-harness-backup-publication.js";

describe("native harness backup publication", () => {
  let backupRoot = "";
  let unsubscribe: (() => void) | undefined;
  afterEach(async () => {
    unsubscribe?.(); unsubscribe = undefined;
    if (backupRoot) await fs.rm(backupRoot, { recursive: true, force: true });
  });
  async function fixture() {
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-publication-"));
    const current = path.join(backupRoot, "current"), pendingRoot = path.join(backupRoot, "pending");
    await fs.mkdir(current); await fs.mkdir(pendingRoot);
    await fs.writeFile(path.join(current, "manifest.json"), "saved");
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), "replacement");
    return { db: {}, companyId: "company", scopeDigest: "scope", backupRoot, pendingRoot, current };
  }
  it("restores the existing backup when its lease stamp fails without publishing a false change", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await expect(publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
      throw new Error("stamp transaction rejected");
    } })).rejects.toThrow("stamp transaction rejected");
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("saved");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); expect(changes).toEqual([]);
  });
  it("publishes the completed replacement once and removes its predecessor", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(changes).toEqual([]);
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
    } });
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]);
    expect(changes).toEqual([{ companyId: input.companyId, scopeDigest: input.scopeDigest }]);
  });
});
