import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  kimiWorkspaceTrustKey,
  resolveKimiCodeHome,
  seedKimiWorkspaceTrust,
} from "./workspace-trust.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix = "paperclip-kimi-trust-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("resolveKimiCodeHome", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers KIMI_CODE_HOME from adapter config env", () => {
    vi.stubEnv("KIMI_CODE_HOME", "/from-process");
    expect(resolveKimiCodeHome({ KIMI_CODE_HOME: "/from-config" })).toBe("/from-config");
  });

  it("falls back to the process KIMI_CODE_HOME", () => {
    vi.stubEnv("KIMI_CODE_HOME", "/from-process");
    expect(resolveKimiCodeHome({})).toBe("/from-process");
  });

  it("falls back to HOME/.kimi-code and tolerates a missing HOME", () => {
    vi.stubEnv("KIMI_CODE_HOME", "");
    vi.stubEnv("HOME", "/home/tester");
    expect(resolveKimiCodeHome({})).toBe("/home/tester/.kimi-code");
    vi.stubEnv("HOME", "");
    expect(resolveKimiCodeHome({})).toBe(path.join(os.homedir(), ".kimi-code"));
  });
});

describe("kimiWorkspaceTrustKey", () => {
  // Golden fixture: a record written by kimi 2.1.1 itself on this host.
  it("reproduces kimi 2.1.1's trackKey byte-for-byte", () => {
    expect(
      kimiWorkspaceTrustKey("/Users/paulodesengrini/Apps/CoreTank/.paperclip/worktrees/COR-3726-3d-patio-cover-builder"),
    ).toBe("wd_cor-3726-3d-patio-cover-builder_be70e8801156");
  });

  it("truncates the slug to 40 characters and trims separators", () => {
    expect(
      kimiWorkspaceTrustKey("/tmp/COR-3680-paperclip-implement-symmetric-implicit-reopen-run-context-gate"),
    ).toBe("wd_cor-3680-paperclip-implement-symmetric-i_25ebbaec971a");
  });

  it("normalizes trailing slashes and backslashes", () => {
    const base = kimiWorkspaceTrustKey("/tmp/my-workspace");
    expect(kimiWorkspaceTrustKey("/tmp/my-workspace/")).toBe(base);
    expect(kimiWorkspaceTrustKey("\\tmp\\my-workspace")).toBe(base);
  });
});

describe("seedKimiWorkspaceTrust (COR-4191 Fix B)", () => {
  let home = "";

  beforeEach(async () => {
    home = await makeTempRoot("paperclip-kimi-home-");
    vi.stubEnv("KIMI_CODE_HOME", home);
    vi.stubEnv("HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function readTrustRecord(root: string) {
    const file = path.join(home, "workspace-trust", kimiWorkspaceTrustKey(root));
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as { root: string; trustedAt: number };
  }

  it("writes kimi-compatible trust state for a provisioned workspace root", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");

    const result = await seedKimiWorkspaceTrust({
      cwd: workspace,
      envConfig: {},
      provisionedWorkspace: true,
    });

    expect(result.seeded).toBe(true);
    const record = await readTrustRecord(workspace);
    expect(record.root).toBe(workspace);
    expect(typeof record.trustedAt).toBe("number");
  });

  it("keeps the trust dir private (0700) and the record private (0600)", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");
    await seedKimiWorkspaceTrust({ cwd: workspace, envConfig: {}, provisionedWorkspace: true });

    const dirStat = await fs.stat(path.join(home, "workspace-trust"));
    const fileStat = await fs.stat(
      path.join(home, "workspace-trust", kimiWorkspaceTrustKey(workspace)),
    );
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("is idempotent: an existing record is left untouched", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");
    await seedKimiWorkspaceTrust({ cwd: workspace, envConfig: {}, provisionedWorkspace: true });
    const first = await readTrustRecord(workspace);

    const second = await seedKimiWorkspaceTrust({
      cwd: workspace,
      envConfig: {},
      provisionedWorkspace: true,
    });

    expect(second.seeded).toBe(false);
    expect(second.reason).toBe("already-trusted");
    expect(await readTrustRecord(workspace)).toEqual(first);
  });

  it("never trusts a bare configured cwd without a provisioned workspace", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");

    const result = await seedKimiWorkspaceTrust({
      cwd: workspace,
      envConfig: {},
      provisionedWorkspace: false,
    });

    expect(result).toEqual({ seeded: false, reason: "no-workspace-context" });
    await expect(fs.access(path.join(home, "workspace-trust"))).rejects.toThrow();
  });

  it("never trusts the filesystem root", async () => {
    const result = await seedKimiWorkspaceTrust({ cwd: "/", envConfig: {}, provisionedWorkspace: true });
    expect(result).toEqual({ seeded: false, reason: "root" });
  });

  it("seeds both the logical and physical form of a symlinked workspace", async () => {
    const real = await makeTempRoot("paperclip-kimi-real-");
    const linkParent = await makeTempRoot("paperclip-kimi-link-");
    const link = path.join(linkParent, "workspace-link");
    await fs.symlink(real, link);

    const result = await seedKimiWorkspaceTrust({
      cwd: link,
      envConfig: {},
      provisionedWorkspace: true,
    });

    expect(result.seeded).toBe(true);
    expect((await readTrustRecord(link)).root).toBe(link);
    expect((await readTrustRecord(await fs.realpath(real))).root).toBe(await fs.realpath(real));
  });

  it("rewrites a malformed existing record", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");
    const dir = path.join(home, "workspace-trust");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, kimiWorkspaceTrustKey(workspace)), "{not json");

    const result = await seedKimiWorkspaceTrust({
      cwd: workspace,
      envConfig: {},
      provisionedWorkspace: true,
    });

    expect(result.seeded).toBe(true);
    expect((await readTrustRecord(workspace)).root).toBe(workspace);
  });

  it("honours KIMI_CODE_HOME from adapter config env over the process env", async () => {
    const workspace = await makeTempRoot("paperclip-kimi-ws-");
    const configuredHome = await makeTempRoot("paperclip-kimi-config-home-");

    await seedKimiWorkspaceTrust({
      cwd: workspace,
      envConfig: { KIMI_CODE_HOME: configuredHome },
      provisionedWorkspace: true,
    });

    const file = path.join(configuredHome, "workspace-trust", kimiWorkspaceTrustKey(workspace));
    await expect(fs.access(file)).resolves.toBeUndefined();
  });
});
