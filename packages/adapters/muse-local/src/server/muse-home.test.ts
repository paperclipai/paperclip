import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkStagedMuseCredentialReadiness,
  promoteMuseDeviceLoginCredential,
  readCompanyMuseApiKey,
  resolveManagedMuseHomeDir,
} from "./muse-home.js";

const KEY_A = "LLM|444444444444444|companykeyaaaaaaaaaaaaaaa";
const KEY_B = "LLM|555555555555555|companykeybbbbbbbbbbbbbbb";
const auth = (key: string) => Buffer.from(JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth", api_key: key, access_token: "dca:secret", user_email: "person@example.com" } } }));

let home: string;
const logs: string[] = [];
const promote = (key: string, overrides: Partial<Parameters<typeof promoteMuseDeviceLoginCredential>[0]> = {}) =>
  promoteMuseDeviceLoginCredential({
    authBytes: auth(key), companyId: "company-1", userInitiated: true,
    isSoleActiveOwner: () => true, log: (line) => { logs.push(line); }, ...overrides,
  });

describe("Muse company credential home", () => {
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-home-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    logs.length = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("promotes only the key into a private company file", async () => {
    await expect(promote(KEY_A)).resolves.toBe("promoted");
    const dir = resolveManagedMuseHomeDir(process.env, "company-1");
    expect(await fs.readFile(path.join(dir, "api-key"), "utf8")).toBe(KEY_A);
    expect((await fs.stat(path.join(dir, "api-key"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    await expect(readCompanyMuseApiKey(process.env, "company-1")).resolves.toBe(KEY_A);
    expect(logs.join("\n")).not.toMatch(/LLM\||@|dca:/);
  });

  it("replaces the key atomically on a later login", async () => {
    await promote(KEY_A);
    await promote(KEY_B);
    const dir = resolveManagedMuseHomeDir(process.env, "company-1");
    expect(await fs.readFile(path.join(dir, "api-key"), "utf8")).toBe(KEY_B);
    expect((await fs.readdir(dir)).filter((name) => name !== "api-key")).toEqual([]);
  });

  it("never writes for a background login or a lost claim", async () => {
    await expect(promote(KEY_A, { userInitiated: false })).resolves.toBe("background_skipped");
    await expect(promote(KEY_A, { isSoleActiveOwner: () => false })).resolves.toBe("not_sole_owner");
    await expect(readCompanyMuseApiKey(process.env, "company-1")).resolves.toBeNull();
  });

  it.each(["", "..", "a/b"])("rejects unsafe company id %j", async (companyId) => {
    await expect(promote(KEY_A, { companyId })).rejects.toThrow();
  });

  it("checks readiness from the staged file shape only", () => {
    expect(checkStagedMuseCredentialReadiness(auth(KEY_A))).toEqual({ ready: true });
    expect(checkStagedMuseCredentialReadiness(Buffer.from("{}")).ready).toBe(false);
    expect(checkStagedMuseCredentialReadiness(Buffer.from(JSON.stringify({ providers: { meta: { storage: "keychain" } } }))).ready).toBe(false);
    expect(checkStagedMuseCredentialReadiness(Buffer.alloc(70 * 1024, 32)).ready).toBe(false);
  });
});
