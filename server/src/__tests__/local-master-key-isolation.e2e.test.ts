import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  companies,
  companySecretVersions,
  createDb,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertIsolatedLocalSecretsKey } from "../secrets/local-encrypted-provider.js";
import { secretService } from "../services/secrets.js";

// Opt in because this e2e requires a local Docker daemon and an agent image.
// It uses only a disposable database, random key, and random secret value.
const enabled = process.env.PAPERCLIP_RUN_MASTER_KEY_ISOLATION_E2E === "1";
const support = enabled ? await getEmbeddedPostgresTestSupport() : { supported: false };
const serviceUid = process.getuid?.();
const agentUid = serviceUid === 1000 ? 1001 : 1000;
const image = process.env.PAPERCLIP_TEST_AGENT_IMAGE ?? "node:24-bookworm-slim";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!enabled || !support.supported || process.platform !== "linux" || !serviceUid)(
  "isolated local key with disposable Postgres and a separate agent UID",
  () => {
    it("denies key and decrypt to the agent while the server decrypts across migration, restart and rollback", async () => {
      const root = mkdtempSync(path.join(repoRoot, ".paperclip-key-e2e-"));
      chmodSync(root, 0o755); // The agent may read ciphertext, but not private directories.
      const initialDir = path.join(root, "initial");
      const privateDir = path.join(root, "private");
      const backupDir = path.join(root, "backup");
      for (const dir of [initialDir, privateDir, backupDir]) mkdirSync(dir, { mode: 0o700 });
      const initialKey = path.join(initialDir, "master.key");
      const protectedKey = path.join(privateDir, "master.key");
      const backupKey = path.join(backupDir, "master.key");
      writeFileSync(initialKey, randomBytes(32).toString("base64"), { mode: 0o600 });
      const previousKeyPath = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      const previousInlineKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      const previousIsolation = process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME;
      const previousAgentUid = process.env.PAPERCLIP_SECRETS_HOST_AGENT_UID;
      let cleanupDb: (() => Promise<void>) | null = null;
      try {
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", initialKey);
        const started = await startEmbeddedPostgresTestDatabase("master-key-isolation");
        cleanupDb = started.cleanup;
        const db = createDb(started.connectionString);
        const companyId = randomUUID();
        await db.insert(companies).values({
          id: companyId,
          name: "Synthetic isolation company",
          issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const value = randomBytes(32).toString("base64");
        const valueHash = createHash("sha256").update(value).digest("hex");
        const service = secretService(db);
        const secret = await service.create(companyId, {
          name: "synthetic-isolation-probe",
          provider: "local_encrypted",
          value,
        });
        expect((await service.resolveSecretValue(companyId, secret.id, "latest")) === value).toBe(true);
        const versions = await db.select({ material: companySecretVersions.material })
          .from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
        expect(versions).toHaveLength(1);
        writeFileSync(path.join(root, "material.json"), JSON.stringify(versions[0]?.material), { mode: 0o644 });

        // Take a matched database/key backup before moving the same key bytes.
        const backup = await runDatabaseBackup({
          connectionString: started.connectionString,
          backupDir,
          retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
          filenamePrefix: "synthetic-isolation",
        });
        expect(backup.sizeBytes > 0).toBe(true);
        copyFileSync(initialKey, backupKey);
        renameSync(initialKey, protectedKey);
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", protectedKey);
        vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
        vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String(agentUid));
        expect(() => assertIsolatedLocalSecretsKey({ enabled: true, keyFilePath: protectedKey, hostAgentUid: agentUid })).not.toThrow();
        expect((await service.resolveSecretValue(companyId, secret.id, "latest")) === value).toBe(true);

        const probe = fileURLToPath(new URL("./fixtures/isolated-key-server-probe.ts", import.meta.url));
        const childEnv = {
          ...process.env,
          PAPERCLIP_TEST_DATABASE_URL: started.connectionString,
          PAPERCLIP_TEST_COMPANY_ID: companyId,
          PAPERCLIP_TEST_SECRET_ID: secret.id,
          PAPERCLIP_TEST_VALUE_HASH: valueHash,
        };
        const restartProbe = () => spawnSync(process.execPath, ["--import", "tsx", probe], {
          cwd: path.join(repoRoot, "server"), env: childEnv, encoding: "utf8", timeout: 30_000,
        });
        expect(restartProbe().status).toBe(0);

        const agentProbe = path.join(root, "agent-probe.cjs");
        writeFileSync(agentProbe, `
const fs = require('node:fs');
const crypto = require('node:crypto');
const material = JSON.parse(fs.readFileSync('/case/material.json', 'utf8'));
if (!material || !material.ciphertext || fs.existsSync('/var/run/docker.sock')) process.exit(2);
for (const keyPath of ['/case/private/master.key', '/case/backup/master.key']) {
  try { fs.readFileSync(keyPath); process.exit(3); }
  catch (error) { if (error.code !== 'EACCES') process.exit(4); }
}
try {
  const key = Buffer.from(fs.readFileSync('/case/private/master.key', 'utf8').trim(), 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(material.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(material.tag, 'base64'));
  cipher.update(Buffer.from(material.ciphertext, 'base64')); cipher.final();
  process.exit(5);
} catch (error) { if (error.code !== 'EACCES') process.exit(6); }
`, { mode: 0o644 });
        execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64",
          "--user", `${agentUid}:${agentUid}`, "--volume", `${root}:/case:ro`, image,
          "node", "/case/agent-probe.cjs"], { stdio: "ignore", timeout: 60_000 });

        // Restore the matched synthetic database and key into a fresh database.
        const adminUrl = new URL(started.connectionString);
        adminUrl.pathname = "/postgres";
        const restoreName = "paperclip_isolation_rollback";
        await ensurePostgresDatabase(adminUrl.toString(), restoreName);
        const restoreUrl = new URL(started.connectionString);
        restoreUrl.pathname = `/${restoreName}`;
        await runDatabaseRestore({
          connectionString: restoreUrl.toString(),
          backupFile: backup.backupFile,
        });
        copyFileSync(backupKey, protectedKey);
        childEnv.PAPERCLIP_TEST_DATABASE_URL = restoreUrl.toString();
        expect(restartProbe().status).toBe(0);
      } finally {
        await cleanupDb?.();
        if (previousKeyPath === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyPath;
        if (previousInlineKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousInlineKey;
        if (previousIsolation === undefined) delete process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME;
        else process.env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME = previousIsolation;
        if (previousAgentUid === undefined) delete process.env.PAPERCLIP_SECRETS_HOST_AGENT_UID;
        else process.env.PAPERCLIP_SECRETS_HOST_AGENT_UID = previousAgentUid;
        rmSync(root, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
