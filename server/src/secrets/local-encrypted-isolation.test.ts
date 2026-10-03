import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedLocalSecretsKey, localEncryptedProvider } from "./local-encrypted-provider.js";

const roots: string[] = [];
const serverUid = process.getuid?.();
const agentUid = serverUid === 1000 ? 1001 : 1000;

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".paperclip-isolation-test-"));
  roots.push(root);
  const dir = path.join(root, "secrets");
  mkdirSync(dir, { mode: 0o700 });
  const key = path.join(dir, "master.key");
  writeFileSync(key, randomBytes(32).toString("base64"), { mode: 0o600 });
  return { root, dir, key };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("isolated local encrypted key preflight", () => {
  it.skipIf(process.platform !== "linux" || serverUid === 0)("keeps server decrypt working with a distinct host agent UID", async () => {
    const { key } = fixture();
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", key);
    expect(() => assertIsolatedLocalSecretsKey({ enabled: true, keyFilePath: key, hostAgentUid: agentUid })).not.toThrow();

    const syntheticValue = randomBytes(24).toString("base64");
    const prepared = await localEncryptedProvider.createSecret({ value: syntheticValue } as never);
    const resolved = await localEncryptedProvider.resolveVersion({ material: prepared.material } as never);
    expect(resolved === syntheticValue).toBe(true);
    // Loading the provider a second time reads the durable key file again.
    expect(await localEncryptedProvider.resolveVersion({ material: prepared.material } as never) === syntheticValue).toBe(true);
  });

  it.skipIf(process.platform !== "linux" || serverUid === 0)("rejects the same UID, inline key, loose mode and symlink", async () => {
    const { dir, key } = fixture();
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
    const input = { enabled: true, keyFilePath: key, hostAgentUid: agentUid };
    expect(() => assertIsolatedLocalSecretsKey({ ...input, hostAgentUid: serverUid ?? null })).toThrow(/must differ/);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "synthetic-inline-key");
    expect(() => assertIsolatedLocalSecretsKey(input)).toThrow(/inline master key/);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
    chmodSync(key, 0o640);
    expect(() => assertIsolatedLocalSecretsKey(input)).toThrow(/mode 0600/);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", key);
    vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String(agentUid));
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    expect((await localEncryptedProvider.healthCheck()).status).toBe("error");
    chmodSync(key, 0o600);
    const link = path.join(dir, "linked.key");
    symlinkSync(key, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => assertIsolatedLocalSecretsKey({ ...input, keyFilePath: link })).toThrow(/regular service-owned file/);
  });
});
