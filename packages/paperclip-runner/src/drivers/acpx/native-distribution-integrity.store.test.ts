import { once } from "node:events";
import { constants } from "node:fs";
import { fork, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { createNativeAcpxDistributionSnapshot, NATIVE_ACPX_STORE_ROOT_ENV, NativeAcpxStoreRootError, readNativeAcpxDistributionEntries, pruneNativeAcpxStores, scheduledNativeAcpxStorePrune, type NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { filePrototype, fixture, hash, output, roots, storeRoot, unsealAndRemove, useNativeStoreFixtures } from "./native-distribution-integrity.test-support.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), rm: vi.fn(original.rm), mkdir: vi.fn(original.mkdir), chmod: vi.fn(original.chmod), rename: vi.fn(original.rename) };
});

useNativeStoreFixtures();

describe("native ACPX verified store reuse", () => {
  const storeFiles = (declaration: NativeAcpxDistributionInput) => join(storeRoot, declaration.expectedClosureSha256, "distribution");
  const createdFiles = () => vi.mocked(open).mock.calls.filter(([, flags]) => typeof flags === "number" && (flags & constants.O_CREAT) !== 0).map(([path]) => String(path));
  async function tamper(path: string, bytes: string): Promise<void> {
    await chmod(path, 0o700); await writeFile(path, bytes); await chmod(path, 0o500);
  }

  it("verifies a closure once; a later launch reads and copies no closure bytes", async () => {
    const declaration = await fixture();
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const read = vi.spyOn(prototype, "read");
    expect((await output((await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn())).text).toBe("native:fixed:none");
    expect(read).toHaveBeenCalled();
    read.mockClear(); vi.mocked(open).mockClear();
    // A new installation object models the next run in a fresh runner.
    const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    expect(read).not.toHaveBeenCalled();
    expect(createdFiles().filter(path => path.startsWith(storeRoot))).toEqual([]);
    expect(vi.mocked(open).mock.calls.map(([path]) => String(path))).not.toContain(join(declaration.distributionRoot, "runtime"));
    expect(await output(lease.spawn())).toEqual({ text: "native:fixed:none", error: "", code: 0 });
    await lease.close();
  });

  it("detects a tampered verified store, retires it and relaunches from a fresh verification", async () => {
    const declaration = await fixture();
    const installation = await verifyNativeAcpxInstallation(declaration);
    await (await installation.openCommand()).close();
    const stored = join(storeFiles(declaration), "runtime");
    const before = await stat(stored);
    const original = await readFile(stored);
    await tamper(stored, '#!/bin/sh\nprintf "tampered:%s:%s" "$1" "${COPILOT_PKG_CACHE_HOME:-n}"\n'.slice(0, original.length).padEnd(original.length, "#"));
    vi.mocked(open).mockClear();
    const lease = await installation.openCommand();
    expect(await output(lease.spawn())).toEqual({ text: "native:fixed:none", error: "", code: 0 });
    await lease.close();
    expect(await readFile(stored)).toEqual(original);
    // The file system may reuse the freed inode, so the rebuild is proven by
    // the new store's files being written, not by a different inode.
    expect(createdFiles().filter(path => path.startsWith(storeRoot) && path.endsWith("/runtime"))).toHaveLength(1);
    expect((await stat(stored)).ctimeMs).toBeGreaterThanOrEqual(before.ctimeMs);
    expect((await readdir(storeRoot)).filter(name => name.startsWith(".retired-") || name.startsWith(".staging-"))).toEqual([]);
  });

  it("refuses to spawn an executable whose bytes changed after the launch was admitted", async () => {
    const declaration = await fixture();
    const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    const stored = join(storeFiles(declaration), "runtime");
    const size = (await stat(stored)).size;
    await tamper(stored, '#!/bin/sh\nprintf tampered-code-executed\n'.padEnd(size, "#"));
    const result = await output(lease.spawn());
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("Native ACPX executable changed before spawn");
    expect(result.text).not.toContain("tampered-code-executed");
    await lease.close();
  });

  it("refuses an executable swapped into the store together with a rewritten verification record", async () => {
    const declaration = await fixture();
    const installation = await verifyNativeAcpxInstallation(declaration);
    await (await installation.openCommand()).close();
    const store = join(storeRoot, declaration.expectedClosureSha256);
    const distribution = join(store, "distribution");
    const stored = join(distribution, "runtime");
    const original = await readFile(stored);
    // A process running as the runner's user can unseal the store, replace the
    // executable and rewrite the record with the replacement's identity. The
    // record is not a trust anchor: the executable must still match its pin.
    await chmod(store, 0o700); await chmod(distribution, 0o700);
    await rm(stored);
    await writeFile(stored, "#!/bin/sh\nprintf forged-code-executed\n".padEnd(original.length, "#"), { mode: 0o500 });
    await chmod(stored, 0o500);
    const recordPath = join(store, "verified.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { entries: Array<{ path: string; identity: string[] }> };
    const replaced = await stat(stored, { bigint: true });
    for (const entry of record.entries) {
      if (entry.path === "runtime") entry.identity = [replaced.dev, replaced.ino, replaced.size, replaced.mtimeNs, replaced.ctimeNs].map(String);
    }
    await chmod(recordPath, 0o600); await writeFile(recordPath, JSON.stringify(record)); await chmod(recordPath, 0o400);
    await chmod(distribution, 0o500); await chmod(store, 0o500);
    const lease = await installation.openCommand();
    const result = await output(lease.spawn());
    expect(result.text).not.toContain("forged-code-executed");
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("Native ACPX executable changed before spawn");
    await lease.close();
  });

  it("re-hashes a changed installed source in place without copying it again", async () => {
    const declaration = await fixture();
    await (await (await verifyNativeAcpxInstallation(declaration)).openCommand()).close();
    const storeBefore = await stat(join(storeFiles(declaration), "runtime"));
    const source = join(await realpath(declaration.distributionRoot), "runtime");
    await writeFile(source, await readFile(source));
    const prototype = await filePrototype(source);
    const read = vi.spyOn(prototype, "read"); vi.mocked(open).mockClear();
    const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    expect(vi.mocked(open).mock.calls.map(([path]) => String(path))).toContain(source);
    expect(read).toHaveBeenCalled();
    expect(createdFiles().filter(path => path.startsWith(storeRoot))).toEqual([]);
    expect((await stat(join(storeFiles(declaration), "runtime"))).ino).toBe(storeBefore.ino);
    await lease.close();
    // A source changed to different bytes is still refused, as before.
    await writeFile(source, "altered");
    await expect((await verifyNativeAcpxInstallation(declaration)).openCommand()).rejects.toThrow();
  });

  it("never renames a sealed store directory, which some macOS releases refuse", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // Model macOS 15: moving a directory its owner cannot write fails.
    vi.mocked(rename).mockImplementation(async (from, to) => {
      const info = await actual.lstat(from);
      if (info.isDirectory() && (info.mode & 0o200) === 0) throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
      return await actual.rename(from, to);
    });
    const old = { ...await fixture(), storeFamily: "sealed-provider" };
    const installation = await verifyNativeAcpxInstallation(old);
    const first = await installation.openCommand();
    expect((await output(first.spawn())).text).toBe("native:fixed:none");
    await first.close();
    expect((await stat(join(storeRoot, old.expectedClosureSha256))).mode & 0o777).toBe(0o500);
    // A damaged store is retired and rebuilt.
    const stored = join(storeFiles(old), "runtime");
    await tamper(stored, (await readFile(stored, "utf8")).replace("native", "nativf"));
    const second = await installation.openCommand();
    expect((await output(second.spawn())).text).toBe("native:fixed:none");
    await second.close();
    // A superseded store no live runner holds is retired.
    await rename(join(storeRoot, `${old.expectedClosureSha256}.lease-${process.pid}`), join(storeRoot, `${old.expectedClosureSha256}.lease-${spawnSync("true").pid!}`));
    expect(await pruneNativeAcpxStores(storeRoot, "sealed-provider", hash("next"))).toEqual([old.expectedClosureSha256]);
    expect((await readdir(storeRoot)).filter(name => name.startsWith("."))).toEqual([]);
  });

  it("publishes exactly one verified store for concurrent first launches", async () => {
    const declaration = await fixture();
    const installation = await verifyNativeAcpxInstallation(declaration);
    const leases = await Promise.all([installation.openCommand(), installation.openCommand(), installation.openCommand()]);
    for (const lease of leases) expect((await output(lease.spawn())).text).toBe("native:fixed:none");
    await Promise.all(leases.map(lease => lease.close()));
    expect((await readdir(storeRoot)).filter(name => !name.endsWith(".source.json"))).toEqual([declaration.expectedClosureSha256]);
  });

  it("refuses to launch from a configured store root another user could write", async () => {
    const declaration = await fixture();
    const shared = await mkdtemp(join(tmpdir(), "native-acpx-shared-store-")); roots.push(shared);
    await chmod(shared, 0o777);
    process.env[NATIVE_ACPX_STORE_ROOT_ENV] = shared;
    const failure = (await verifyNativeAcpxInstallation(declaration)).openCommand();
    await expect(failure).rejects.toBeInstanceOf(NativeAcpxStoreRootError);
    await expect(failure).rejects.toThrow(`${NATIVE_ACPX_STORE_ROOT_ENV} must name an absolute directory owned by the runner user`);
    expect(await readdir(shared)).toEqual([]);
  });

  describe("an unsafe default store root", () => {
    const previousTmpdir = process.env.TMPDIR;
    let temporary = "";
    beforeEach(async () => {
      temporary = await realpath(await mkdtemp(join(tmpdir(), "native-acpx-tmpdir-"))); roots.push(temporary);
      delete process.env[NATIVE_ACPX_STORE_ROOT_ENV];
      process.env.TMPDIR = temporary;
      // Another user squatted the per-uid default root.
      await mkdir(join(temporary, `paperclip-verified-native-${process.getuid!()}`), { mode: 0o777 });
      await chmod(join(temporary, `paperclip-verified-native-${process.getuid!()}`), 0o777);
    });
    afterEach(() => { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; });
    const privateStores = async () => (await readdir(temporary)).filter(name => /^paperclip-verified-native-(?!\d+$)/.test(name));

    it("reports the fallback and removes the process-private store with its last launch", async () => {
      const declaration = await fixture();
      const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      const installation = await verifyNativeAcpxInstallation(declaration);
      const first = await installation.openCommand();
      const second = await installation.openCommand();
      expect(await privateStores()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("default_store_root_not_private"), expect.objectContaining({ code: "PAPERCLIP_ACPX_NATIVE_STORE_FALLBACK" }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(temporary);
      expect((await output(first.spawn())).text).toBe("native:fixed:none");
      await first.close();
      expect(await privateStores()).toHaveLength(1);
      expect((await output(second.spawn())).text).toBe("native:fixed:none");
      await second.close();
      expect(await privateStores()).toEqual([]);
      expect(await readdir(join(temporary, `paperclip-verified-native-${process.getuid!()}`))).toEqual([]);
    });

    it("retries a failed launch cleanup and keeps the private store until it succeeds", async () => {
      vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      const declaration = await fixture();
      const snapshot = await createNativeAcpxDistributionSnapshot(declaration, await readNativeAcpxDistributionEntries(declaration));
      await snapshot.commandDirectory.close();
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let failures = 1;
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (failures > 0 && String(path).includes("paperclip-acpx-native-")) { failures--; throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); }
        return await actual.rm(path, options);
      });
      await expect(snapshot.snapshot.close()).rejects.toThrow("EBUSY");
      expect(await privateStores()).toHaveLength(1);
      await snapshot.snapshot.close();
      expect(await privateStores()).toEqual([]);
      await snapshot.snapshot.close();
    });
  });

  describe("superseded closure stores", () => {
    const script = (marker: string) => `#!/bin/sh\nprintf "${marker}:%s" "$1"\n`;
    const launch = async (declaration: NativeAcpxDistributionInput) => {
      const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
      const result = await output(lease.spawn());
      await lease.close();
      return result.text;
    };
    /** Hand this process's lease on `closure` to a runner process that has exited. */
    const releaseToExitedRunner = async (closure: string) => {
      const exited = spawnSync("true").pid!;
      await rename(join(storeRoot, `${closure}.lease-${process.pid}`), join(storeRoot, `${closure}.lease-${exited}`));
    };

    it("retires a provider's superseded closure once no live runner holds it, and nothing else", async () => {
      const old = { ...await fixture({ script: script("old") }), storeFamily: "fixture-provider" };
      const other = { ...await fixture({ script: script("other") }), storeFamily: "other-provider" };
      const unmarked = await fixture({ script: script("unmarked") });
      for (const declaration of [old, other, unmarked]) await launch(declaration);
      await releaseToExitedRunner(old.expectedClosureSha256);
      await releaseToExitedRunner(other.expectedClosureSha256);
      const current = { ...await fixture({ script: script("current") }), storeFamily: "fixture-provider" };
      expect(await launch(current)).toBe("current:fixed");
      expect(await scheduledNativeAcpxStorePrune("fixture-provider", current.expectedClosureSha256)).toEqual([old.expectedClosureSha256]);
      const names = await readdir(storeRoot);
      expect(names.filter(name => name.startsWith(old.expectedClosureSha256))).toEqual([]);
      expect(names).toEqual(expect.arrayContaining([current.expectedClosureSha256, other.expectedClosureSha256, unmarked.expectedClosureSha256]));
      expect(names.filter(name => name.startsWith(".retiring-") || name.startsWith(".retired-"))).toEqual([]);
      // A later launch of the retired closure verifies it again from source.
      expect(await launch(old)).toBe("old:fixed");
    });

    const moduleUrl = new URL("./installation-integrity.ts", import.meta.url).href;
    const storeModuleUrl = new URL("./native-distribution-integrity.ts", import.meta.url).href;
    /** Runs a script in a separate runner process sharing this test's store root. */
    const runChild = async (name: string, body: string) => {
      const scripts = await realpath(await mkdtemp(join(tmpdir(), "native-acpx-race-scripts-"))); roots.push(scripts);
      const file = join(scripts, name);
      await writeFile(file, body);
      const child = fork(file, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, [NATIVE_ACPX_STORE_ROOT_ENV]: storeRoot } });
      const result = await output(child);
      expect(result.code, result.error).toBe(0);
      return result.text.trim();
    };
    /** Another runner verifies the store, runs it and exits, so no live lease holds it. */
    const verifyInExitedRunner = async (declaration: NativeAcpxDistributionInput) => {
      expect(await runChild("verify.mjs", [
        `const { verifyNativeAcpxInstallation } = await import(${JSON.stringify(moduleUrl)});`,
        `const lease = await (await verifyNativeAcpxInstallation(${JSON.stringify(declaration)})).openCommand();`,
        "await lease.close();", 'console.log("verified");',
      ].join("\n"))).toBe("verified");
    };

    it("keeps a store that another runner process starts using while it is being pruned", async () => {
      const family = "race-provider";
      const old = { ...await fixture({ script: script("raced") }), storeFamily: family };
      const keep = hash("current closure");
      await verifyInExitedRunner(old);
      // This runner starts using the store. Right after it has checked the
      // store, a third runner prunes the closure as superseded.
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let pruned: string | undefined;
      vi.mocked(open).mockImplementation((async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
        if (pruned === undefined && String(path) === join(storeRoot, `${old.expectedClosureSha256}.source.json`)) {
          pruned = await runChild("prune.mjs", [
            `const { pruneNativeAcpxStores } = await import(${JSON.stringify(storeModuleUrl)});`,
            `console.log(JSON.stringify(await pruneNativeAcpxStores(${JSON.stringify(storeRoot)}, ${JSON.stringify(family)}, ${JSON.stringify(keep)})));`,
          ].join("\n"));
        }
        return await (actual.open as (...args: unknown[]) => Promise<FileHandle>)(path, ...rest);
      }) as typeof open);
      const lease = await (await verifyNativeAcpxInstallation(old)).openCommand();
      vi.mocked(open).mockImplementation(actual.open);
      expect(pruned).toBe("[]");
      expect(await output(lease.spawn())).toEqual({ text: "raced:fixed", error: "", code: 0 });
      await lease.close();
      const names = await readdir(storeRoot);
      expect(names).toEqual(expect.arrayContaining([old.expectedClosureSha256, `${old.expectedClosureSha256}.family`, `${old.expectedClosureSha256}.source.json`]));
      expect(names.filter(name => name.startsWith(".retiring-") || name.includes(".pruning-"))).toEqual([]);
    }, 60_000);

    it("waits for a live prune of the closure before reading its store, and cleans trees an exited pruner left", async () => {
      const old = { ...await fixture({ script: script("waited") }), storeFamily: "wait-provider" };
      await verifyInExitedRunner(old);
      // A live process (this test's helper) is mid-prune of the closure.
      const exitedPruner = spawnSync("true").pid!;
      const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      const marker = join(storeRoot, `${old.expectedClosureSha256}.pruning-${helper.pid}`);
      await writeFile(marker, "");
      const abandoned = join(storeRoot, `.retiring-${exitedPruner}-left-behind`);
      await mkdir(join(abandoned, "distribution"), { recursive: true }); await chmod(join(abandoned, "distribution"), 0o500); await chmod(abandoned, 0o500);
      let settled = false;
      const reading = (async () => {
        const lease = await (await verifyNativeAcpxInstallation({ ...old })).openCommand();
        settled = true;
        return lease;
      })();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      // The prune finishes: it retired the store and removed its records.
      await unsealAndRemove(join(storeRoot, old.expectedClosureSha256));
      await rm(join(storeRoot, `${old.expectedClosureSha256}.source.json`)); await rm(join(storeRoot, `${old.expectedClosureSha256}.family`));
      await rm(marker);
      const lease = await reading;
      helper.kill("SIGKILL");
      expect((await output(lease.spawn())).text).toBe("waited:fixed");
      await lease.close();
      expect(await readFile(join(storeRoot, `${old.expectedClosureSha256}.family`), "utf8")).toBe("wait-provider");
      expect(await pruneNativeAcpxStores(storeRoot, "wait-provider", hash("next"))).toEqual([]);
      expect((await readdir(storeRoot)).filter(name => name.startsWith(".retiring-"))).toEqual([]);
    });

    it("retires a closure whose previous pruner was killed mid-prune", async () => {
      const old = { ...await fixture({ script: script("killed") }), storeFamily: "killed-provider" };
      await verifyInExitedRunner(old);
      // A runner killed between writing its prune marker and removing it.
      const killed = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      await once(killed, "spawn");
      await writeFile(join(storeRoot, `${old.expectedClosureSha256}.pruning-${killed.pid}`), "");
      killed.kill("SIGKILL");
      await once(killed, "exit");
      expect(await pruneNativeAcpxStores(storeRoot, "killed-provider", hash("next"))).toEqual([old.expectedClosureSha256]);
      expect((await readdir(storeRoot)).filter(name => name.startsWith(old.expectedClosureSha256))).toEqual([]);
    });

    it("never retires a superseded store that a live runner still holds", async () => {
      const old = { ...await fixture({ script: script("held") }), storeFamily: "held-provider" };
      await launch(old);
      const current = { ...await fixture({ script: script("next") }), storeFamily: "held-provider" };
      await launch(current);
      expect(await scheduledNativeAcpxStorePrune("held-provider", current.expectedClosureSha256)).toEqual([]);
      expect(await readdir(join(storeRoot, old.expectedClosureSha256))).toContain("distribution");
      expect(await pruneNativeAcpxStores(storeRoot, "held-provider", current.expectedClosureSha256)).toEqual([]);
      await releaseToExitedRunner(old.expectedClosureSha256);
      expect(await pruneNativeAcpxStores(storeRoot, "held-provider", current.expectedClosureSha256)).toEqual([old.expectedClosureSha256]);
      expect(await pruneNativeAcpxStores(storeRoot, "held-provider", old.expectedClosureSha256)).toEqual([]);
    });
  });
});
