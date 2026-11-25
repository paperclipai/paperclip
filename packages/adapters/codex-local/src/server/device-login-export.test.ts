import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_AUTH_JSON_BYTES,
  deriveProofHome,
  installDeviceLoginCredential,
  removeProofHome,
  resolveProofHomeRoot,
} from "./device-login-export.js";
import { resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";

const COMPANY = "company-a";
const RUN = "run-1234";
const NEWER = "2026-07-09T02:00:00Z";
const OLDER = "2026-07-09T01:00:00Z";
const ACCOUNT = "acct-42";
const OTHER_ACCOUNT = "acct-99";
const TOKEN_SENTINEL = "SENTINEL_TOKEN_XYZ";

describe("device-login credential export", () => {
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-proof-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function envFor(instanceHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PAPERCLIP_HOME: instanceHome, PAPERCLIP_INSTANCE_ID: "default", ...extra };
  }

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker?: string }): Buffer {
    const suffix = input.marker ?? input.accountId;
    return Buffer.from(
      JSON.stringify({
        tokens: {
          id_token: `id-token-${suffix}`,
          access_token: `access-token-${suffix}`,
          refresh_token: `${TOKEN_SENTINEL}-${suffix}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      }),
    );
  }

  const noopLog = (_line: string): void => {};

  it("deriveProofHome returns a unique, run-scoped path under a company-scoped root", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const root = resolveProofHomeRoot(env, COMPANY);
    expect(root).toBe(
      path.resolve(home, "instances", "default", "companies", COMPANY, "codex-device-login-proof"),
    );
    const a = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    const b = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    expect(a.startsWith(root + path.sep)).toBe(true);
    expect(a).toContain(RUN);
    expect(a).not.toBe(b); // unique per call
    // Never the shared or the managed home.
    expect(a).not.toBe(resolveSharedCodexHomeDir(env));
    expect(a).not.toBe(resolveManagedCodexHomeDir(env, COMPANY));
  });

  it("export_creates_root_and_home_at_mode_0700", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    const root = resolveProofHomeRoot(env, COMPANY);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(proofHome)).mode & 0o777).toBe(0o700);
  });

  it("export_seeds_empty_proof_home_with_mode_0600", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    const outcome = await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    expect(outcome).toBe("seeded");
    const authPath = path.join(proofHome, "auth.json");
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(written.tokens.account_id).toBe(ACCOUNT);
  });

  it("export_rejects_default_shared_and_managed_home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home, { CODEX_HOME: path.join(home, "shared-codex") });
    const bytes = subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER });
    const shared = resolveSharedCodexHomeDir(env);
    const managed = resolveManagedCodexHomeDir(env, COMPANY);
    const agentManaged = path.resolve(managed, "..", "agents", "agent-1", "codex-home");
    for (const target of [shared, managed, agentManaged]) {
      await expect(
        installDeviceLoginCredential({ sandboxAuthBytes: bytes, proofHome: target, env, companyId: COMPANY, log: noopLog }),
      ).rejects.toThrow();
    }
  });

  it("export_rejects_symlink_or_non_regular_path", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const root = resolveProofHomeRoot(env, COMPANY);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const bytes = subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER });

    // A symlinked proof home is rejected.
    const realDir = path.join(home, "elsewhere");
    await mkdir(realDir, { recursive: true, mode: 0o700 });
    const linkedHome = path.join(root, `${RUN}-linked`);
    await symlink(realDir, linkedHome);
    await expect(
      installDeviceLoginCredential({ sandboxAuthBytes: bytes, proofHome: linkedHome, env, companyId: COMPANY, log: noopLog }),
    ).rejects.toThrow();

    // A proof home whose auth.json is a symlink is rejected.
    const symAuthHome = path.join(root, `${RUN}-symauth`);
    await mkdir(symAuthHome, { recursive: true, mode: 0o700 });
    await symlink(path.join(home, "target.json"), path.join(symAuthHome, "auth.json"));
    await expect(
      installDeviceLoginCredential({ sandboxAuthBytes: bytes, proofHome: symAuthHome, env, companyId: COMPANY, log: noopLog }),
    ).rejects.toThrow();
  });

  it("export_rejects_api_key_malformed_or_oversized_payload", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const apiKey = Buffer.from(JSON.stringify({ OPENAI_API_KEY: "sk-secret-key" }));
    const malformed = Buffer.from("this is not json {");
    const oversized = Buffer.concat([
      subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      Buffer.alloc(MAX_AUTH_JSON_BYTES + 10, 0x20),
    ]);
    for (const bytes of [apiKey, malformed, oversized]) {
      const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
      await expect(
        installDeviceLoginCredential({ sandboxAuthBytes: bytes, proofHome, env, companyId: COMPANY, log: noopLog }),
      ).rejects.toThrow();
      // No file was written on a rejected payload.
      await expect(stat(path.join(proofHome, "auth.json"))).rejects.toThrow();
    }
  });

  it("export_updates_home_with_strictly_newer_same_identity", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    const authPath = path.join(proofHome, "auth.json");
    await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "old" }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    const outcome = await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "new" }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    expect(outcome).toBe("updated");
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(written.last_refresh).toBe(NEWER);
    expect(written.tokens.refresh_token).toContain("new");
  });

  it("export_keeps_home_on_older_or_different_identity", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    const authPath = path.join(proofHome, "auth.json");
    await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "keep" }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    // Older same identity: kept.
    const olderOutcome = await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "older" }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    expect(olderOutcome).toBe("kept");
    // Different identity, even newer: kept.
    const otherOutcome = await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: OTHER_ACCOUNT, lastRefresh: NEWER, marker: "other" }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    expect(otherOutcome).toBe("kept");
    const written = JSON.parse(await readFile(authPath, "utf8"));
    expect(written.tokens.account_id).toBe(ACCOUNT);
    expect(written.tokens.refresh_token).toContain("keep");
  });

  it("export_logs_contain_no_token_bytes", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    const logs: string[] = [];
    await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      proofHome,
      env,
      companyId: COMPANY,
      log: (line) => {
        logs.push(line);
      },
    });
    const haystack = logs.join("\n");
    expect(haystack).not.toContain(TOKEN_SENTINEL);
    expect(haystack).not.toContain(ACCOUNT);
  });

  it("cleanup_removes_proof_home_and_leaves_default_home_unchanged", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home, { CODEX_HOME: path.join(home, "shared-codex") });
    // A sentinel in a fake shared/default home must survive the cleanup.
    const shared = resolveSharedCodexHomeDir(env);
    await mkdir(shared, { recursive: true, mode: 0o700 });
    const sentinel = path.join(shared, "auth.json");
    await writeFile(sentinel, JSON.stringify({ tokens: { account_id: "host", refresh_token: "host" } }), { mode: 0o600 });

    const proofHome = deriveProofHome({ env, companyId: COMPANY, runId: RUN });
    await installDeviceLoginCredential({
      sandboxAuthBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      proofHome,
      env,
      companyId: COMPANY,
      log: noopLog,
    });
    expect((await lstat(proofHome)).isDirectory()).toBe(true);

    await removeProofHome(proofHome, { env, companyId: COMPANY });
    await expect(lstat(proofHome)).rejects.toThrow();
    // The fake default home is untouched.
    expect(await readFile(sentinel, "utf8")).toContain("host");
  });

  it("removeProofHome refuses a path outside the proof root", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const outside = path.join(home, "not-a-proof-home");
    await mkdir(outside, { recursive: true });
    await expect(removeProofHome(outside, { env, companyId: COMPANY })).rejects.toThrow();
    // The outside directory is untouched.
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });
});
