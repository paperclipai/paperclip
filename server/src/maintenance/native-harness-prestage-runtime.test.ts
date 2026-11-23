import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalEncryptedCipher } from "../secrets/local-encrypted-provider.js";
import { initializeNativeHarnessPrestageKey, nativeHarnessPrestageDatabaseUrl } from "./native-harness-prestage-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("writes backups with the configured app key even after its file disappears", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prestage-key-")); roots.push(root);
  const keyFile = path.join(root, "custom-secrets.key"), key = randomBytes(32).toString("hex");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", ""); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  await initializeNativeHarnessPrestageKey(keyFile);
  await fs.unlink(keyFile);
  const prepared = createLocalEncryptedCipher("write").encrypt("saved harness key");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  expect(createLocalEncryptedCipher("read").decrypt(prepared)).toBe("saved harness key");
});

it("does not create a replacement when the configured key is missing or invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prestage-key-missing-")); roots.push(root);
  const keyFile = path.join(root, "missing.key");
  await expect(initializeNativeHarnessPrestageKey(keyFile, {})).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.stat(keyFile).catch(() => null)).toBeNull();
  await fs.writeFile(keyFile, "invalid", { mode: 0o600 });
  await expect(initializeNativeHarnessPrestageKey(keyFile, {})).rejects.toThrow("native_harness_prestage_key_invalid");
  expect(await fs.readFile(keyFile, "utf8")).toBe("invalid");
});

it("keeps explicit environment key and file precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prestage-key-env-")); roots.push(root);
  const keyFile = path.join(root, "override.key"), configured = path.join(root, "configured.key");
  const key = randomBytes(32).toString("base64");
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  const env = { PAPERCLIP_SECRETS_MASTER_KEY_FILE: keyFile };
  await initializeNativeHarnessPrestageKey(configured, env);
  expect(env).toMatchObject({ PAPERCLIP_SECRETS_MASTER_KEY: key, PAPERCLIP_SECRETS_MASTER_KEY_FILE: keyFile });
  await fs.unlink(keyFile);
  await initializeNativeHarnessPrestageKey(configured, env);
  expect(await fs.stat(configured).catch(() => null)).toBeNull();
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("prestage database waits", () => {
  it("bounds a real blocked transaction on every connection", async () => {
    const database = await startEmbeddedPostgresTestDatabase("prestage-wait-");
    const source = new URL(database.connectionString); source.searchParams.set("application_name", "prestage-test");
    const url = nativeHarnessPrestageDatabaseUrl(source.href), db = createDb(url, { maxConnections: 2 });
    let release!: () => void, held!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const lock = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(939193)`); held();
      await new Promise<void>(resolve => { release = resolve; }); });
    try {
      await ready;
      const [settings] = await db.execute(sql`select current_setting('lock_timeout') lock_timeout,
        current_setting('statement_timeout') statement_timeout, current_setting('idle_in_transaction_session_timeout') idle_timeout,
        current_setting('application_name') application_name`);
      expect(settings).toEqual({ lock_timeout: "5s", statement_timeout: "30s", idle_timeout: "30s", application_name: "prestage-test" });
      const started = Date.now();
      await expect(db.transaction(tx => tx.execute(sql`select pg_advisory_xact_lock(939193)`)))
        .rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(Date.now() - started).toBeLessThan(10_000);
      const waiting = db.execute(sql`select pg_sleep(20)`);
      const rejected = expect(waiting).rejects.toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 100));
      await closeRegisteredClients(url, { scope: "database" });
      await rejected;
    } finally { release(); await lock.catch(() => {}); await closeRegisteredClients(url, { scope: "database" }); await database.cleanup(); }
  }, 90_000);
});
