import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  managedHomeKeychainPath,
  provisionManagedHomeKeychain,
  releaseManagedHomeKeychain,
  type SecurityCommandRunner,
} from "../services/managed-home-keychain.ts";

const execFileAsync = promisify(execFile);

function recordingRunner(failOn?: string) {
  const calls: { args: string[]; home: string | undefined }[] = [];
  const run: SecurityCommandRunner = async (args, env) => {
    calls.push({ args, home: env.HOME });
    if (failOn && args[0] === failOn) throw new Error(`${failOn} failed`);
  };
  return { calls, run };
}

describe("managed home keychain", () => {
  const homes: string[] = [];

  async function tempHome() {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-keychain-test-"));
    homes.push(home);
    return home;
  }

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("does nothing outside macOS", async () => {
    const home = await tempHome();
    const { calls, run } = recordingRunner();

    await expect(provisionManagedHomeKeychain(home, { platform: "linux", run })).resolves.toBe(false);
    await releaseManagedHomeKeychain(home, { platform: "linux", run });

    expect(calls).toEqual([]);
    await expect(stat(path.join(home, "Library"))).rejects.toThrow();
  });

  it("creates an unlocked keychain and makes it the only keychain for the managed HOME", async () => {
    const home = await tempHome();
    const keychain = managedHomeKeychainPath(home);
    const { calls, run } = recordingRunner();

    await expect(provisionManagedHomeKeychain(home, { platform: "darwin", run })).resolves.toBe(true);

    expect(calls.map((call) => call.args)).toEqual([
      ["create-keychain", "-p", "", keychain],
      ["set-keychain-settings", keychain],
      ["unlock-keychain", "-p", "", keychain],
      ["list-keychains", "-d", "user", "-s", keychain],
      ["default-keychain", "-d", "user", "-s", keychain],
    ]);
    // Every command must run with HOME set to the managed home, so the
    // search-list and default changes stay out of the operator's preferences.
    expect(calls.every((call) => call.home === home)).toBe(true);
    expect((await stat(path.dirname(keychain))).isDirectory()).toBe(true);
    expect((await stat(path.join(home, "Library", "Preferences"))).isDirectory()).toBe(true);
  });

  it("never fails the run when a security command fails, and logs the failed step", async () => {
    const home = await tempHome();
    const { calls, run } = recordingRunner("unlock-keychain");
    const warnings: { details: { err: unknown; step: string }; message: string }[] = [];

    await expect(
      provisionManagedHomeKeychain(home, {
        platform: "darwin",
        run,
        warn: (details, message) => warnings.push({ details, message }),
      }),
    ).resolves.toBe(false);
    // It stops at the failed step and does not change the search list.
    expect(calls.map((call) => call.args[0])).toEqual([
      "create-keychain",
      "set-keychain-settings",
      "unlock-keychain",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.details.step).toBe("unlock-keychain");
    expect(warnings[0]!.details.err).toBeInstanceOf(Error);
    expect(warnings[0]!.message).toContain("keychain setup failed");

    const release = recordingRunner("delete-keychain");
    await expect(
      releaseManagedHomeKeychain(home, { platform: "darwin", run: release.run }),
    ).resolves.toBeUndefined();
  });

  it("deletes the per-run keychain with HOME set to the managed home", async () => {
    const home = await tempHome();
    const { calls, run } = recordingRunner();

    await releaseManagedHomeKeychain(home, { platform: "darwin", run });

    expect(calls).toEqual([
      { args: ["delete-keychain", managedHomeKeychainPath(home)], home },
    ]);
  });

  it.runIf(process.platform === "darwin")(
    "on macOS, gives the managed HOME a writable keychain without touching the operator's",
    async () => {
      const operatorKeychains = async () => ({
        defaultKeychain: (await execFileAsync("/usr/bin/security", ["default-keychain"])).stdout,
        searchList: (await execFileAsync("/usr/bin/security", ["list-keychains", "-d", "user"])).stdout,
      });
      const before = await operatorKeychains();
      const home = await tempHome();
      const env = { ...process.env, HOME: home };

      await expect(provisionManagedHomeKeychain(home)).resolves.toBe(true);
      try {
        const managedDefault = await execFileAsync("/usr/bin/security", ["default-keychain"], { env });
        expect(managedDefault.stdout).toContain(managedHomeKeychainPath(home));
        const managedSearchList = await execFileAsync("/usr/bin/security", ["list-keychains", "-d", "user"], { env });
        expect(managedSearchList.stdout).toContain(managedHomeKeychainPath(home));
        // The operator's settings stay the same while the run is active.
        expect(await operatorKeychains()).toEqual(before);
        // A keychain write under the managed HOME succeeds instead of raising
        // the "Keychain Not Found" dialog.
        await execFileAsync(
          "/usr/bin/security",
          ["add-generic-password", "-a", "paperclip-test", "-s", "paperclip-test", "-w", "not-a-secret"],
          { env },
        );
      } finally {
        await releaseManagedHomeKeychain(home);
      }

      // Both the default keychain and the search list are unchanged afterwards.
      expect(await operatorKeychains()).toEqual(before);
    },
  );
});
