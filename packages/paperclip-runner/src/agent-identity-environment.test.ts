import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createSanitizedCodexEnvironment } from "./drivers/codex/app-server-transport.js";
import { createIsolatedCodexAppServerArgs } from "./drivers/codex/codex-security-config.js";
import { createSanitizedAcpxSpawnInput } from "./drivers/acpx/environment.js";

afterEach(() => vi.unstubAllEnvs());

it("native Codex and ACPX provider processes receive explicit identity and can sign", () => {
  const keys = generateKeyPairSync("ed25519");
  const environment = {
    PAPERCLIP_AGENT_KEY_ID: "sha256:test-key",
    PAPERCLIP_AGENT_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    PAPERCLIP_AGENT_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const challenge = randomBytes(32);
  const source = `const {sign}=require('node:crypto'); process.stdout.write(sign(null,Buffer.from(process.argv[1],'hex'),process.env.PAPERCLIP_AGENT_PRIVATE_KEY).toString('base64'));`;
  for (const env of [createSanitizedCodexEnvironment(environment), createSanitizedAcpxSpawnInput(environment, "codex").env]) {
    expect(env).toMatchObject(environment);
    const signature = execFileSync(process.execPath, ["-e", source, challenge.toString("hex")], { env });
    expect(verify(null, challenge, keys.publicKey, Buffer.from(signature.toString(), "base64"))).toBe(true);
  }
  const args = createIsolatedCodexAppServerArgs(environment).join("\n");
  expect(args).toContain('shell_environment_policy.inherit="all"');
  expect(args).toContain("PAPERCLIP_AGENT_PRIVATE_KEY");
  expect(args).not.toContain(environment.PAPERCLIP_AGENT_PRIVATE_KEY.split("\n")[1]);
});

it("native launchers do not adopt identity from an ambient host environment", () => {
  vi.stubEnv("PAPERCLIP_AGENT_PRIVATE_KEY", "ambient-forged-key");
  expect(createSanitizedCodexEnvironment().PAPERCLIP_AGENT_PRIVATE_KEY).toBeUndefined();
  expect(createSanitizedAcpxSpawnInput(undefined, "codex").env.PAPERCLIP_AGENT_PRIVATE_KEY).toBeUndefined();
});
