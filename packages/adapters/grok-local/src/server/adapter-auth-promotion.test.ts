import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertUsableGrokAuthShape,
  checkStagedGrokCredentialReadiness,
  DeviceLoginReadinessError,
  promoteGrokDeviceLoginCredential,
  type CredentialReadinessResult,
} from "./adapter-auth-promotion.js";
import { resolveManagedGrokHomeDir } from "./grok-home.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const ISSUER = "https://issuer.x.ai";
const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_B = "8f14e45f-ceea-467e-a4b6-8b0e12345678";
const TOKEN_SENTINEL = "SENTINEL_REFRESH_TOKEN_XYZ";

// This suite proves the Grok device-login credential promotion helper. It runs
// an independent readiness check on the exact staged credential first, then
// validates its shape, then writes only the company-scoped credential home. It
// writes only while the session holds the sole active claim on the slot, and
// only for a user-initiated login. It never writes the instance-global host,
// never crosses a company boundary, and never logs a secret.
describe("grok device-login credential promotion", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeInstanceRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-grok-promotion-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function envFor(instanceHome: string): NodeJS.ProcessEnv {
    return {
      PAPERCLIP_HOME: instanceHome,
      PAPERCLIP_INSTANCE_ID: "default",
    };
  }

  function grokAuth(input: { uuid: string; issuer?: string; marker?: string }): Buffer {
    const suffix = input.marker ?? input.uuid;
    return Buffer.from(
      JSON.stringify({
        [`${input.issuer ?? ISSUER}::${input.uuid}`]: {
          key: `api-key-${suffix}`,
          refresh_token: `${TOKEN_SENTINEL}-${suffix}`,
          expires_at: "2026-01-01T00:00:00Z",
          oidc_issuer: input.issuer ?? ISSUER,
          oidc_client_id: "client-1",
          email: `user-${suffix}@example.com`,
          first_name: "Test",
          last_name: "User",
          user_id: `user-${suffix}`,
          principal_id: `principal-${suffix}`,
          team_id: `team-${suffix}`,
        },
      }),
    );
  }

  const ready = (): CredentialReadinessResult => ({ ready: true });
  const notReady = (): CredentialReadinessResult => ({ ready: false, reason: "auth_unusable" });
  const soleOwner = () => true;
  const notSoleOwner = () => false;
  const noopLog = (_line: string): void => {};

  function companyHomeAuthPath(env: NodeJS.ProcessEnv, companyId: string): string {
    return path.join(resolveManagedGrokHomeDir(env, companyId), "auth.json");
  }

  // ---------------------------------------------------------------------
  // Shape validation.
  // ---------------------------------------------------------------------

  describe("assertUsableGrokAuthShape", () => {
    it("rejects empty bytes", () => {
      expect(() => assertUsableGrokAuthShape(Buffer.alloc(0))).toThrow(/empty/);
    });

    it("rejects oversized bytes", () => {
      const big = Buffer.alloc(64 * 1024 + 1, "a");
      expect(() => assertUsableGrokAuthShape(big)).toThrow(/oversized/);
    });

    it("rejects invalid JSON", () => {
      expect(() => assertUsableGrokAuthShape(Buffer.from("{not json"))).toThrow(/invalid JSON/);
    });

    it("rejects an object with no top-level key", () => {
      expect(() => assertUsableGrokAuthShape(Buffer.from("{}"))).toThrow(/single/);
    });

    it("rejects an object with more than one top-level key", () => {
      const bytes = Buffer.from(
        JSON.stringify({
          [`${ISSUER}::${UUID_A}`]: { key: "k", refresh_token: "r" },
          [`${ISSUER}::${UUID_B}`]: { key: "k2", refresh_token: "r2" },
        }),
      );
      expect(() => assertUsableGrokAuthShape(bytes)).toThrow(/single/);
    });

    it("rejects a key that does not match the <issuer>::<uuid> shape", () => {
      const bytes = Buffer.from(JSON.stringify({ some_fixed_key: { key: "k", refresh_token: "r" } }));
      expect(() => assertUsableGrokAuthShape(bytes)).toThrow(/single/);
    });

    it("rejects a value with no usable key or refresh_token", () => {
      const bytes = Buffer.from(JSON.stringify({ [`${ISSUER}::${UUID_A}`]: { key: "k" } }));
      expect(() => assertUsableGrokAuthShape(bytes)).toThrow(/usable/);
    });

    it("accepts an object whose single key matches <issuer>::<uuid> and holds key + refresh_token", () => {
      const payload = assertUsableGrokAuthShape(grokAuth({ uuid: UUID_A }));
      expect(payload.identityKey).toBe(`${ISSUER}::${UUID_A}`);
      expect(payload.value.key).toBe(`api-key-${UUID_A}`);
    });
  });

  // ---------------------------------------------------------------------
  // Readiness.
  // ---------------------------------------------------------------------

  describe("checkStagedGrokCredentialReadiness", () => {
    it("reports not ready for empty bytes", async () => {
      const result = await checkStagedGrokCredentialReadiness(Buffer.alloc(0));
      expect(result.ready).toBe(false);
    });

    it("reports not ready for a Codex-shaped payload", async () => {
      const codexShaped = Buffer.from(JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
      const result = await checkStagedGrokCredentialReadiness(codexShaped);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe("no_usable_auth");
    });

    it("reports ready for a usable Grok payload", async () => {
      const result = await checkStagedGrokCredentialReadiness(grokAuth({ uuid: UUID_A }));
      expect(result.ready).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // The promotion order and gates.
  // ---------------------------------------------------------------------

  it("a failed readiness check rejects and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const logs: string[] = [];
    await expect(
      promoteGrokDeviceLoginCredential({
        authBytes: grokAuth({ uuid: UUID_A }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: notReady,
        isSoleActiveOwner: soleOwner,
        env,
        log: (line) => {
          logs.push(line);
        },
      }),
    ).rejects.toBeInstanceOf(DeviceLoginReadinessError);

    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
    expect(logs.join("\n")).not.toContain(TOKEN_SENTINEL);
    expect(logs.join("\n")).not.toContain("example.com");
  });

  it("an invalid shape rejects after a passed readiness check and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await expect(
      promoteGrokDeviceLoginCredential({
        authBytes: Buffer.from("{}"),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow(/single/);
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
  });

  it("skips a background (non-user-initiated) login and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: false,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("background_skipped");
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
  });

  it("skips a session that lost the sole active claim and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: notSoleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("not_sole_owner");
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
  });

  it("creates the company Grok home at mode 0700 and writes auth.json at exact mode 0600", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("promoted");

    const companyHome = resolveManagedGrokHomeDir(env, COMPANY_A);
    const dirStat = await lstat(companyHome);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const authPath = path.join(companyHome, "auth.json");
    const fileStat = await lstat(authPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(Object.keys(written)).toEqual([`${ISSUER}::${UUID_A}`]);
  });

  it("normalizes the company Grok home to mode 0700 when the home already exists at a broader mode", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const companyHome = resolveManagedGrokHomeDir(env, COMPANY_A);
    await mkdir(companyHome, { recursive: true, mode: 0o755 });

    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("promoted");

    const dirStat = await lstat(companyHome);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const authPath = path.join(companyHome, "auth.json");
    const fileStat = await lstat(authPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("keeps an occupied home that holds a different identity", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const first = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(first).toBe("promoted");

    const second = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_B }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(second).toBe("kept_foreign_identity");

    const authPath = companyHomeAuthPath(env, COMPANY_A);
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(Object.keys(written)).toEqual([`${ISSUER}::${UUID_A}`]);
  });

  it("redacts the credential bytes and the account email the same way on a promoted and on a kept_foreign_identity outcome", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const logs: string[] = [];
    const captureLog = (line: string): void => {
      logs.push(line);
    };

    const promoted = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: captureLog,
    });
    expect(promoted).toBe("promoted");

    const keptForeign = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_B }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: captureLog,
    });
    expect(keptForeign).toBe("kept_foreign_identity");

    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(TOKEN_SENTINEL);
    expect(allLogs).not.toContain(`user-${UUID_A}@example.com`);
    expect(allLogs).not.toContain(`user-${UUID_B}@example.com`);
    expect(allLogs).not.toContain(UUID_A);
    expect(allLogs).not.toContain(UUID_B);
  });

  it("overwrites the home with a refreshed credential for the same identity", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A, marker: "first" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A, marker: "second" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("promoted");

    const authPath = companyHomeAuthPath(env, COMPANY_A);
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(written[`${ISSUER}::${UUID_A}`].refresh_token).toBe(`${TOKEN_SENTINEL}-second`);
  });

  // ---------------------------------------------------------------------
  // Fail closed on an unreadable or unparseable existing home.
  // ---------------------------------------------------------------------

  it("keeps a home whose auth.json holds corrupt JSON, and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const companyHome = resolveManagedGrokHomeDir(env, COMPANY_A);
    await mkdir(companyHome, { recursive: true, mode: 0o700 });
    const authPath = path.join(companyHome, "auth.json");
    const corruptBytes = Buffer.from("{not valid json");
    await writeFile(authPath, corruptBytes, { mode: 0o600 });

    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("kept_foreign_identity");

    const afterBytes = await readFile(authPath);
    expect(afterBytes.equals(corruptBytes)).toBe(true);
  });

  it("keeps a home whose auth.json holds a well-formed but unusable payload, and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const companyHome = resolveManagedGrokHomeDir(env, COMPANY_A);
    await mkdir(companyHome, { recursive: true, mode: 0o700 });
    const authPath = path.join(companyHome, "auth.json");
    const unusableBytes = Buffer.from(JSON.stringify({ some_fixed_key: { key: "k" } }));
    await writeFile(authPath, unusableBytes, { mode: 0o600 });

    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("kept_foreign_identity");

    const afterBytes = await readFile(authPath);
    expect(afterBytes.equals(unusableBytes)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Atomic write.
  // ---------------------------------------------------------------------

  it("leaves no staged temporary file in the company home after a successful promotion", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("promoted");

    const companyHome = resolveManagedGrokHomeDir(env, COMPANY_A);
    const entries = await readdir(companyHome);
    expect(entries).toEqual(["auth.json"]);
  });

  // ---------------------------------------------------------------------
  // Company isolation.
  // ---------------------------------------------------------------------

  it("a promotion for company A creates no file, replaces no file, and reads no file under company B's home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);

    // Seed company B's home first, so a read-through would be observable.
    const companyBHome = resolveManagedGrokHomeDir(env, COMPANY_B);
    await mkdir(companyBHome, { recursive: true, mode: 0o700 });
    const companyBAuthPath = path.join(companyBHome, "auth.json");
    const companyBBytes = grokAuth({ uuid: UUID_B });
    await writeFile(companyBAuthPath, companyBBytes, { mode: 0o600 });
    const beforeBBytes = await readFile(companyBAuthPath);

    const outcome = await promoteGrokDeviceLoginCredential({
      authBytes: grokAuth({ uuid: UUID_A }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(outcome).toBe("promoted");

    // Company A's write landed only under company A's home.
    const companyAAuthPath = companyHomeAuthPath(env, COMPANY_A);
    expect(resolveManagedGrokHomeDir(env, COMPANY_A)).not.toBe(companyBHome);
    await expect(lstat(companyAAuthPath)).resolves.toBeDefined();

    // Company B's home is byte-identical to before the company A promotion.
    const afterBBytes = await readFile(companyBAuthPath);
    expect(afterBBytes.equals(beforeBBytes)).toBe(true);
  });

  it("rejects a companyId that holds a path separator", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await expect(
      promoteGrokDeviceLoginCredential({
        authBytes: grokAuth({ uuid: UUID_A }),
        companyId: `${COMPANY_A}/../${COMPANY_B}`,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow(/path separator/);
    await expect(lstat(resolveManagedGrokHomeDir(env, COMPANY_B))).rejects.toThrow();
  });

  it("rejects a companyId that is a parent-directory segment", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await expect(
      promoteGrokDeviceLoginCredential({
        authBytes: grokAuth({ uuid: UUID_A }),
        companyId: "..",
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow(/relative path segment/);
  });
});
