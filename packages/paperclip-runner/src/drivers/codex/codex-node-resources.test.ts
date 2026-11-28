import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePinnedCodexCommand } from "./codex-command.js";
import { codexNodeReadOnlyRoots } from "./codex-node-resources.js";
import { codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } from "./codex-security-config.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync), closeSync: vi.fn(actual.closeSync) };
});

const OPENSSL_CONFIG = "/System/Library/OpenSSL/openssl.cnf";

describe("Codex Node resources", () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

  function mockConfig() {
    const stat = Object.assign(fs.statSync(process.execPath), { uid: 0, nlink: 1, mode: 0o100644 });
    const canonical = vi.mocked(fs.realpathSync).mockReturnValue(OPENSSL_CONFIG);
    const open = vi.mocked(fs.openSync).mockReturnValue(123);
    vi.mocked(fs.fstatSync).mockReturnValue(stat);
    const close = vi.mocked(fs.closeSync).mockImplementation(() => {});
    return { stat, canonical, open, close };
  }

  it("grants only the validated OS file, independently of environment overrides, in both profiles", () => {
    const fixture = mockConfig();
    vi.stubEnv("OPENSSL_CONF", "/workspace/untrusted.cnf");
    vi.stubEnv("OPENSSL_MODULES", "/workspace/untrusted-modules");
    const roots = codexNodeReadOnlyRoots("darwin");
    expect(roots).toEqual([OPENSSL_CONFIG]);
    expect(fixture.open).toHaveBeenCalledWith(OPENSSL_CONFIG, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    expect(fixture.close).toHaveBeenCalledWith(123);
    const args = createIsolatedCodexAppServerArgs({ HOME: "/excluded-provider" }, roots);
    for (const profile of ["paperclip-runner-workspace-only", "paperclip-runner-workspace-read-only"]) {
      const rule = args.find(value => value.startsWith(`permissions.${profile}.filesystem=`))!;
      expect(rule).toContain(`${JSON.stringify(OPENSSL_CONFIG)}="read"`);
      expect(rule).toContain('"/excluded-provider"="none"');
      for (const root of ["/System", "/System/Library/OpenSSL", "/workspace/untrusted.cnf", "/workspace/untrusted-modules"]) {
        expect(rule).not.toContain(`${JSON.stringify(root)}="read"`);
      }
    }
  });

  it.each(["linux", "win32"] as const)("does no macOS discovery on %s", platform => {
    const fixture = mockConfig();
    expect(codexNodeReadOnlyRoots(platform)).toEqual([]);
    expect(fixture.canonical).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("leaves absent or unreadable resources ungranted", () => {
    const fixture = mockConfig();
    fixture.canonical.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(codexNodeReadOnlyRoots("darwin")).toEqual([]);
    expect(fixture.open).not.toHaveBeenCalled();
    fixture.canonical.mockReturnValue(OPENSSL_CONFIG);
    fixture.open.mockImplementation(() => { throw new Error("EACCES"); });
    expect(codexNodeReadOnlyRoots("darwin")).toEqual([]);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it.each(["/", "/System", "relative.cnf", "/workspace/escape.cnf", "/System/Library/OpenSSL/../secret", `${OPENSSL_CONFIG}\n`])(
    "rejects a redirected or malformed discovered path %j without opening it", canonical => {
      const fixture = mockConfig();
      fixture.canonical.mockReturnValue(canonical);
      expect(codexNodeReadOnlyRoots("darwin")).toEqual([]);
      expect(fixture.open).not.toHaveBeenCalled();
    },
  );

  it.each([{ uid: 501 }, { mode: 0o100664 }, { mode: 0o100646 }, { nlink: 2 }, { isFile: () => false }])(
    "rejects an untrusted resource descriptor %j and closes it", values => {
      const fixture = mockConfig();
      Object.assign(fixture.stat, values);
      expect(codexNodeReadOnlyRoots("darwin")).toEqual([]);
      expect(fixture.close).toHaveBeenCalledWith(123);
    },
  );

  it("fails closed when the file becomes a symlink between lookup and open", () => {
    const fixture = mockConfig();
    fixture.open.mockImplementation(() => { throw new Error("ELOOP"); });
    expect(codexNodeReadOnlyRoots("darwin")).toEqual([]);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin" && existsSync(OPENSSL_CONFIG))(
    "starts real Node in both sandbox profiles while excluding sentinels and denying resource writes",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-node-resources-")));
      const home = join(root, "provider"), workspace = join(root, "workspace");
      const homeSentinel = join(home, "nonsecret-sentinel"), unrelated = join(root, "unrelated-sentinel");
      const protectedSentinel = join(workspace, "protected-sentinel");
      const readOnlySentinel = join(root, "read-only-sentinel");
      try {
        mkdirSync(home); mkdirSync(workspace);
        for (const file of [homeSentinel, unrelated, protectedSentinel, readOnlySentinel]) writeFileSync(file, "nonsecret fixture");
        const command = resolvePinnedCodexCommand();
        const source = { HOME: home, CODEX_HOME: home, PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };
        const roots = codexExecutableReadOnlyRoots(source, command);
        const args = createIsolatedCodexAppServerArgs(source, [...roots, readOnlySentinel], undefined, [protectedSentinel]).slice(0, -1);
        for (const profile of ["paperclip-runner-workspace-only", "paperclip-runner-workspace-read-only"]) {
          const script = `
            const assert = require("node:assert/strict"), fs = require("node:fs");
            const denied = error => ["EPERM", "EACCES", "EROFS"].includes(error.code);
            for (const file of process.argv.slice(1, 4)) assert.throws(() => fs.readFileSync(file), denied);
            assert.ok(fs.readFileSync(process.argv[4]).length > 0);
            assert.throws(() => fs.openSync(process.argv[4], "r+"), denied);
            assert.ok(fs.readFileSync(process.argv[5]).length > 0);
            assert.throws(() => fs.openSync(process.argv[5], "r+"), denied);
            if (process.argv[6] === "paperclip-runner-workspace-only") fs.writeFileSync("allowed-write", "fixture");
            else assert.throws(() => fs.writeFileSync("planning-write", "fixture"), denied);
            console.log("node-started; sentinels-denied; config-read-only");
          `;
          const output = execFileSync(command, ["sandbox", ...args, "-P", profile, "-C", workspace, "--", process.execPath,
            "-e", script, homeSentinel, unrelated, protectedSentinel, OPENSSL_CONFIG, readOnlySentinel, profile], {
            env: source, cwd: workspace, encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"],
          });
          expect(output.trim()).toBe("node-started; sentinels-denied; config-read-only");
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
    60_000,
  );
});
