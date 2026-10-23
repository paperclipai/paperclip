import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { secretsConfigSchema } from "./schema.js";
import { ensureLocalSecretsKeyFile } from "./secrets-key.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses to generate or use an inline master key for an isolated store", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".paperclip-key-cli-test-"));
  roots.push(root);
  const keyFilePath = path.join(root, "master.key");
  const config = {
    secrets: secretsConfigSchema.parse({
      provider: "local_encrypted",
      localEncrypted: { keyFilePath, requireIsolatedAgentRuntime: true },
    }),
  };
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
  expect(() => ensureLocalSecretsKeyFile(config)).toThrow(/existing operator-managed key/);
  writeFileSync(keyFilePath, randomBytes(32).toString("base64"), { mode: 0o600 });
  expect(ensureLocalSecretsKeyFile(config).status).toBe("existing");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
  expect(() => ensureLocalSecretsKeyFile(config)).toThrow(/inline master key/);
});
