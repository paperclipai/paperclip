import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountDir,
  deleteAccountFiles,
  provisionOauthAccount,
  readApiKeyValue,
  readOauthCredentials,
  setApiKeyResolver,
} from "./account-store.js";

describe("account-store", () => {
  const cleanupDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-account-store-"));
    cleanupDirs.push(root);
    process.env.HOME = root;
    delete process.env.PAPERCLIP_HOME;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalPaperclipHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = originalPaperclipHome;
    }
    setApiKeyResolver(null);
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  describe("accountDir", () => {
    it("returns ~/.paperclip/anthropic-accounts/<accountId> under HOME", () => {
      const dir = accountDir("acc-123");
      expect(dir).toBe(path.join(process.env.HOME!, ".paperclip", "anthropic-accounts", "acc-123"));
    });

    it("respects PAPERCLIP_HOME when set", () => {
      const customHome = path.join(process.env.HOME!, "alt-home");
      process.env.PAPERCLIP_HOME = customHome;
      const dir = accountDir("acc-456");
      expect(dir).toBe(path.join(customHome, "anthropic-accounts", "acc-456"));
    });
  });

  describe("provisionOauthAccount", () => {
    it("creates the directory with mode 0700", async () => {
      const result = await provisionOauthAccount("acc-perm");
      expect(result.credentialDir).toBe(accountDir("acc-perm"));
      const stat = await fs.stat(result.credentialDir);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it("is idempotent on repeat calls (no-op if exists)", async () => {
      const first = await provisionOauthAccount("acc-idem");
      const before = await fs.stat(first.credentialDir);
      await fs.writeFile(path.join(first.credentialDir, "marker"), "keep", "utf8");
      const second = await provisionOauthAccount("acc-idem");
      expect(second.credentialDir).toBe(first.credentialDir);
      const after = await fs.stat(second.credentialDir);
      expect(after.isDirectory()).toBe(true);
      expect(after.mode & 0o777).toBe(0o700);
      // pre-existing files preserved
      await expect(fs.readFile(path.join(first.credentialDir, "marker"), "utf8")).resolves.toBe(
        "keep",
      );
      // ino unchanged → directory not recreated
      expect(after.ino).toBe(before.ino);
    });

    it("tightens permissions to 0700 if a pre-existing directory is loose", async () => {
      const dir = accountDir("acc-loose");
      await fs.mkdir(dir, { recursive: true, mode: 0o755 });
      await fs.chmod(dir, 0o755);
      await provisionOauthAccount("acc-loose");
      const stat = await fs.stat(dir);
      expect(stat.mode & 0o777).toBe(0o700);
    });
  });

  describe("readOauthCredentials", () => {
    it("returns the file contents when .credentials.json exists", async () => {
      const { credentialDir } = await provisionOauthAccount("acc-read");
      const payload = JSON.stringify({ access_token: "tok", expires_at: 123 });
      await fs.writeFile(path.join(credentialDir, ".credentials.json"), payload, {
        mode: 0o600,
      });
      const got = await readOauthCredentials("acc-read");
      expect(got).toBe(payload);
    });

    it("returns null when the directory does not exist", async () => {
      const got = await readOauthCredentials("acc-missing");
      expect(got).toBeNull();
    });

    it("returns null when the file does not exist", async () => {
      await provisionOauthAccount("acc-empty");
      const got = await readOauthCredentials("acc-empty");
      expect(got).toBeNull();
    });
  });

  describe("deleteAccountFiles", () => {
    it("removes the directory and its contents", async () => {
      const { credentialDir } = await provisionOauthAccount("acc-del");
      await fs.writeFile(path.join(credentialDir, ".credentials.json"), "x", "utf8");
      await deleteAccountFiles("acc-del");
      await expect(fs.stat(credentialDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("is idempotent when the directory does not exist", async () => {
      await expect(deleteAccountFiles("acc-never")).resolves.toBeUndefined();
      await expect(deleteAccountFiles("acc-never")).resolves.toBeUndefined();
    });
  });

  describe("readApiKeyValue", () => {
    it("delegates to the configured resolver", async () => {
      setApiKeyResolver(async (secretId) => `value-for-${secretId}`);
      await expect(readApiKeyValue("secret-1")).resolves.toBe("value-for-secret-1");
    });

    it("throws when no resolver has been registered", async () => {
      setApiKeyResolver(null);
      await expect(readApiKeyValue("secret-1")).rejects.toThrow(
        /api key resolver/i,
      );
    });

    it("propagates errors from the resolver verbatim", async () => {
      setApiKeyResolver(async () => {
        throw new Error("provider unavailable");
      });
      await expect(readApiKeyValue("secret-1")).rejects.toThrow("provider unavailable");
    });
  });
});
