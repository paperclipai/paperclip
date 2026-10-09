import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitVerifiedAcpxProviderExit, awaitVerifiedAcpxProviderOwnership, verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { createNativeAcpxDistributionSnapshot, readNativeAcpxDistributionEntries, parseNativeAcpxDistributionEntries, type NativeAcpxDistributionInput, type NativeAcpxDistributionEntry } from "./native-distribution-integrity.js";
import { openCodexAcpxRuntime } from "./codex-runtime-adapter.js";
import { createAcpxCommandLeaseOwner } from "./command-lease-owner.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm) };
});

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { node?: boolean; script?: string } = {}): Promise<NativeAcpxDistributionInput> {
  const root = await mkdtemp(join(tmpdir(), "native-acpx-test-")); roots.push(root);
  const entries: NativeAcpxDistributionEntry[] = [];
  if (options.node) {
    await copyFile(process.execPath, join(root, "runtime")); await chmod(join(root, "runtime"), 0o700);
    const bytes = await readFile(join(root, "runtime")); entries.push({ path: "runtime", sha256: hash(bytes), size: bytes.length, executable: true });
    // Homebrew's test-host Node uses an @rpath libnode dylib. Include that
    // dependency in this fixture's closure instead of relying on its old path.
    const libraryRoot = join(dirname(process.execPath), "..", "lib");
    for (const name of (await readdir(libraryRoot).catch(() => [] as string[])).filter(name => /^libnode\..*\.dylib$/.test(name))) {
      await copyFile(join(libraryRoot, name), join(root, name)); await chmod(join(root, name), 0o600);
      const library = await readFile(join(root, name)); entries.push({ path: name, sha256: hash(library), size: library.length, executable: false });
    }
    const script = options.script ?? 'console.log("qualified-entry");';
    await writeFile(join(root, "entry.cjs"), script, { mode: 0o600 });
    entries.push({ path: "entry.cjs", sha256: hash(script), size: Buffer.byteLength(script), executable: false });
  } else {
    const script = options.script ?? '#!/bin/sh\nprintf "native:%s:%s" "$1" "${COPILOT_PKG_CACHE_HOME:-none}"\n';
    await writeFile(join(root, "runtime"), script, { mode: 0o700 });
    entries.push({ path: "runtime", sha256: hash(script), size: Buffer.byteLength(script), executable: true });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestPath = join(root, "closure.json");
  await writeFile(manifestPath, JSON.stringify({ entries }));
  return { distributionRoot: root, manifestPath, expectedClosureSha256: hash(JSON.stringify(entries)), executable: "runtime", ...(options.node ? { entrypoint: "entry.cjs" } : {}), fixedArguments: options.node ? [] : ["fixed"] };
}
async function manyFileFixture(sizes: number[]) {
  const declaration = await fixture();
  const entries = await readNativeAcpxDistributionEntries(declaration);
  for (let index = 0; index < sizes.length; index++) {
    const path = `file-${String(index).padStart(2, "0")}`;
    const bytes = Buffer.alloc(sizes[index]!, index + 1);
    await writeFile(join(declaration.distributionRoot, path), bytes, { mode: 0o600 });
    entries.push({ path, sha256: hash(bytes), size: bytes.length, executable: false });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeFile(declaration.manifestPath, JSON.stringify({ entries }));
  return { declaration: { ...declaration, expectedClosureSha256: hash(JSON.stringify(entries)) }, entries };
}
async function filePrototype(path: string): Promise<FileHandle> {
  const probe = await open(path, "r"); const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close(); return prototype;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function output(child: ChildProcess): Promise<{ text: string; error: string; code: number | null }> {
  let text = ""; let error = "";
  child.stdout!.on("data", value => { text += String(value); });
  child.stderr!.on("data", value => { error += String(value); });
  const [code] = await once(child, "close") as [number | null];
  return { text, error, code };
}

describe("native ACPX execution closure", () => {
  it("rejects paths, ordering, oversized files and altered manifest pins", () => {
    const entry = { path: "runtime", sha256: "a".repeat(64), size: 10, executable: true };
    for (const entries of [[{ ...entry, path: "../escape" }], [{ ...entry, path: "/absolute" }], [entry, entry], [{ ...entry, size: 2 ** 40 }], [{ ...entry, unknown: 1 }]]) {
      expect(() => parseNativeAcpxDistributionEntries({ entries }, hash(JSON.stringify(entries)))).toThrow();
    }
    expect(() => parseNativeAcpxDistributionEntries({ entries: [entry] }, "b".repeat(64))).toThrow("manifest digest mismatch");
  });
  it("checks every file digest and refuses links at admission", async () => {
    const declaration = await fixture(); const installation = await verifyNativeAcpxInstallation(declaration);
    await writeFile(join(declaration.distributionRoot, "runtime"), "altered");
    await expect(installation.openCommand()).rejects.toThrow();
    await rm(join(declaration.distributionRoot, "runtime"));
    await symlink("closure.json", join(declaration.distributionRoot, "runtime"));
    await expect(installation.openCommand()).rejects.toThrow("symbolic link");
  });
  it("launches only fixed arguments from a frozen snapshot after installed files change", async () => {
    const declaration = await fixture(); const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    expect(() => lease.spawn(["--untrusted-override"])).toThrow("fixed profile arguments");
    await writeFile(join(declaration.distributionRoot, "runtime"), "changed after lease");
    const result = await output(lease.spawn());
    expect(result).toEqual({ text: "native:fixed:none", error: "", code: 0 });
    expect(() => lease.spawn()).toThrow("closed");
    await lease.close();
  });
  it("awaits consumed command snapshot deletion before lease retirement", async () => {
    const declaration = await fixture();
    const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    const originalRemove = vi.mocked(rm).getMockImplementation()!;
    const deleting = gate(); const holdDeletion = gate();
    let privateRoot: string | undefined;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes("paperclip-acpx-native-")) {
        privateRoot = String(path); deleting.release(); await holdDeletion.promise;
      }
      return await originalRemove(path, options);
    });
    let retired = false;
    let retirement: Promise<void> | undefined;
    try {
      const result = await output(lease.spawn());
      expect(result.code, result.error).toBe(0);
      await deleting.promise;
      retirement = lease.close().then(() => { retired = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retired).toBe(false);
      expect(privateRoot).toBeDefined();
      await expect(stat(privateRoot!)).resolves.toBeDefined();
    } finally {
      holdDeletion.release();
      await retirement;
      if (privateRoot) await vi.waitFor(async () => {
        await expect(stat(privateRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      });
      vi.mocked(rm).mockImplementation(originalRemove);
    }
    expect(retired).toBe(true);
  });
  it("gives packaged executables a fresh private extraction cache each launch", async () => {
    const declaration = { ...await fixture(), isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME" as const };
    const install = await verifyNativeAcpxInstallation(declaration);
    const first = await output((await install.openCommand()).spawn([], { env: { COPILOT_PKG_CACHE_HOME: "/ambient/cache" } }));
    const second = await output((await install.openCommand()).spawn());
    expect(first.text).toMatch(/^native:fixed:.*paperclip-acpx-native-.*\/state$/);
    expect(first.text).not.toBe(second.text);
  });
  it("retains the snapshot until the live provider exits", async () => {
    const declaration = { ...await fixture({ node: true, script: 'console.log(process.env.COPILOT_PKG_CACHE_HOME); setInterval(() => {}, 1000);' }), isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME" as const };
    const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    const child = lease.spawn();
    const completed = output(child);
    let privateRoot: string | undefined;
    try {
      const [chunk] = await once(child.stdout!, "data");
      privateRoot = dirname(String(chunk).trim());
      expect(privateRoot).toContain("paperclip-acpx-native-");
      await expect(lease.close()).rejects.toThrow("cannot retire before provider exit");
      await expect(stat(privateRoot)).resolves.toBeDefined();
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await completed;
      await lease.close();
    }
    await expect(stat(privateRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
  it("reports failed deletion and retries retirement without relaunching", async () => {
    const lease = await (await verifyNativeAcpxInstallation(await fixture())).openCommand();
    const originalRemove = vi.mocked(rm).getMockImplementation()!;
    const deleting = gate(); const holdDeletion = gate();
    let privateRoot: string | undefined;
    let failed = false;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes("paperclip-acpx-native-") && !failed) {
        privateRoot = String(path); deleting.release(); await holdDeletion.promise;
        failed = true; throw new Error("snapshot deletion failed");
      }
      return await originalRemove(path, options);
    });
    try {
      expect((await output(lease.spawn())).code).toBe(0);
      await deleting.promise;
      const rejected = expect(lease.close()).rejects.toThrow("snapshot deletion failed");
      await new Promise<void>(resolve => setImmediate(resolve));
      holdDeletion.release();
      await rejected;
      await expect(stat(privateRoot!)).resolves.toBeDefined();
      expect(() => lease.spawn()).toThrow("closed");
      await lease.close();
      await expect(stat(privateRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      holdDeletion.release();
      vi.mocked(rm).mockImplementation(originalRemove);
      await lease.close();
    }
  });
  it("loads a pinned Node entrypoint while rejecting unqualified external modules", async () => {
    const declaration = await fixture({ node: true });
    const result = await output((await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn());
    expect(result.code, result.error).toBe(0); expect(result.text).toBe("qualified-entry\n");
    const outside = join(declaration.distributionRoot, "outside.cjs"); await writeFile(outside, "module.exports='ambient';");
    const evil = await fixture({ node: true, script: `require(${JSON.stringify(outside)});` });
    const denied = await output((await (await verifyNativeAcpxInstallation(evil)).openCommand()).spawn());
    expect(denied.code).not.toBe(0); expect(denied.error).toContain("escaped its closed distribution");
  }, 30_000);
  it("copies concurrently within its descriptor bound and retains canonical manifest order", async () => {
    const { declaration, entries } = await manyFileFixture(Array.from({ length: 12 }, (_, index) => 100 + index));
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const hold = gate(); const sizes: number[] = []; let active = 0; let peak = 0;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      sizes.push(args[0].length); active++; peak = Math.max(peak, active);
      try { await hold.promise; return await originalRead.apply(this, args as never); }
      finally { active--; }
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    try {
      await vi.waitFor(() => expect(sizes).toHaveLength(8));
      expect(sizes.toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => 100 + index));
    } finally { hold.release(); }
    const created = await creating;
    try {
      expect(peak).toBe(8);
      expect(Object.keys(created.snapshot.digests).slice(0, entries.length)).toEqual(entries.map(entry => join(created.snapshot.roots[0]!, entry.path)));
      for (const entry of entries) expect(hash(await readFile(join(created.snapshot.roots[0]!, entry.path)))).toBe(entry.sha256);
    } finally { await created.commandDirectory.close(); await created.snapshot.close(); }
  });
  it("bounds simultaneous buffers and gives an oversized admitted file exclusive capacity", async () => {
    const mib = 1024 * 1024;
    const { declaration, entries } = await manyFileFixture([17 * mib, 17 * mib, 33 * mib]);
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const retained = new Map<FileHandle, number>(); const observed: number[] = [];
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      if (!retained.has(this)) {
        const file = this; const originalClose = file.close.bind(file);
        file.close = async () => { try { await originalClose(); } finally { retained.delete(file); } };
      }
      retained.set(this, args[0].length);
      const total = [...retained.values()].reduce((sum, size) => sum + size, 0); observed.push(total);
      expect(total).toBeLessThanOrEqual(Math.max(32 * mib, args[0].length));
      if (args[0].length > 32 * mib) expect(retained.size).toBe(1);
      return originalRead.apply(this, args as never);
    });
    const created = await createNativeAcpxDistributionSnapshot(declaration, entries);
    try { expect(Math.max(...observed)).toBe(33 * mib); }
    finally { await created.commandDirectory.close(); await created.snapshot.close(); }
  });
  it("drains every admitted copy before failed-snapshot cleanup and schedules no later batch", async () => {
    const { declaration, entries } = await manyFileFixture(Array.from({ length: 10 }, (_, index) => 91 + index));
    await writeFile(join(declaration.distributionRoot, "file-00"), Buffer.alloc(91, 99));
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const hold = gate(); const entered = gate(); const invalidClosed = gate();
    const readSizes: number[] = []; const removalStart = vi.mocked(rm).mock.calls.length;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      const size = args[0].length; readSizes.push(size);
      if (size === 91) {
        const originalClose = this.close.bind(this);
        this.close = async () => { await originalClose(); invalidClosed.release(); };
        await entered.promise;
      }
      if (size === 92) { entered.release(); await hold.promise; }
      return originalRead.apply(this, args as never);
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    let settled = false;
    void creating.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise; await invalidClosed.promise;
      expect(settled).toBe(false);
    } finally { hold.release(); }
    await expect(creating).rejects.toThrow("digest mismatch: file-00");
    expect(readSizes).not.toContain(99);
    const removals = vi.mocked(rm).mock.calls.slice(removalStart).map(([path]) => String(path)).filter(path => /paperclip-acpx-native-/.test(path));
    expect(removals).toHaveLength(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(stat(removals[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a source mutation while another file is being copied", async () => {
    const { declaration, entries } = await manyFileFixture([101, 102]);
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read; const entered = gate(); const hold = gate();
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      if (args[0].length === 101) { entered.release(); await hold.promise; }
      return originalRead.apply(this, args as never);
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    const rejected = expect(creating).rejects.toThrow("changed while read");
    try {
      await entered.promise;
      await writeFile(join(declaration.distributionRoot, "file-00"), Buffer.alloc(101, 7));
    } finally { hold.release(); }
    await rejected;
  });
  it("uses the existing guardian ownership and provider-exit proof for native children", async () => {
    const declaration = await fixture({ script: '#!/bin/sh\nprintf "ready"\nwhile :; do sleep 1; done\n' });
    const fences = await Promise.all([listen(), listen()]);
    const fds = fences.map(server => (server as Server & { _handle?: { fd?: number } })._handle!.fd!);
    const owners: number[] = [];
    const child = (await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn([], {}, {
      credentialFenceFds: [fds[0]!, fds[1]!], activateCredentialFenceOwner: async pid => { owners.push(pid); },
    });
    let stderr = ""; child.stderr!.on("data", value => { stderr += String(value); });
    try {
      await awaitVerifiedAcpxProviderOwnership(child);
      expect(owners).toEqual([child.pid]);
      const [chunk] = await once(child.stdout!, "data"); expect(String(chunk), stderr).toBe("ready");
      const exited = once(child, "exit"); child.kill(); await exited;
      await awaitVerifiedAcpxProviderExit(child);
    } finally {
      child.kill(); await Promise.all(fences.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    }
  }, 15_000);

  it("proves native child death before any caller cleanup, despite the launcher's pending guardian read", async () => {
    const declaration = await fixture({ node: true, script: 'console.log(process.pid);setInterval(()=>{},1000);' });
    const fences = await Promise.all([listen(), listen()]);
    const fds = fences.map(server => (server as Server & { _handle?: { fd?: number } })._handle!.fd!);
    const child = (await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn([], {}, {
      credentialFenceFds: [fds[0]!, fds[1]!], activateCredentialFenceOwner: async () => undefined,
    });
    const exited = once(child, "exit");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = once(child.stdout!, "data");
      await awaitVerifiedAcpxProviderOwnership(child);
      const [chunk] = await ready;
      const nativePid = Number(String(chunk).trim());
      expect(Number.isSafeInteger(nativePid) && nativePid > 0 && nativePid !== child.pid).toBe(true);
      const proof = awaitVerifiedAcpxProviderExit(child);
      process.kill(nativePid, "SIGKILL");
      // No guardian.kill/close is allowed to manufacture the lifetime proof.
      await Promise.race([proof, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Native exit proof remained open after child death")), 3_000);
      })]);
      await exited;
      expect(() => process.kill(nativePid, 0)).toThrow();
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await Promise.all(fences.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    }
  }, 15_000);

  it("expires a real ACPX permission on native child death without replaying its mutation", async () => {
    // This is a deterministic ACP peer in a verified native distribution. No
    // provider credential, remote service or model is involved.
    const declaration = await fixture({ node: true, script: blockingCopilotPeer });
    const fences = await Promise.all([listen(), listen()]);
    const fds = fences.map(server => (server as Server & { _handle?: { fd?: number } })._handle!.fd!);
    const installation = await verifyNativeAcpxInstallation(declaration);
    const owner = createAcpxCommandLeaseOwner(await installation.openCommand(), installation.openCommand);
    const pidFile = join(declaration.distributionRoot, "native-pid");
    let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      port = await openCodexAcpxRuntime({
        command: owner.command, refreshConsumedCommand: owner.refreshConsumedCommand,
        profile: resolveQualifiedAcpxProfile("copilot", "gpt-5.6-luna"),
        cwd: declaration.distributionRoot, stateDirectory: join(declaration.distributionRoot, "state"),
        providerSessionKey: "native-death-fixture", permissionMode: "approve-reads",
        permissionPolicy: { autoApprove: ["read"], escalate: ["write"], defaultAction: "escalate" },
        launchEnvironment: { PATH: "/usr/bin:/bin", NATIVE_TEST_PID_FILE: pidFile },
        credentialFenceFds: [fds[0]!, fds[1]!], activateCredentialFenceOwner: async () => undefined,
        systemInstructions: "Read task context before editing.", mcpServers: [], retainFailedAdmissionCleanup: () => undefined,
      });
      let pending!: () => void;
      const requested = new Promise<void>(resolve => { pending = resolve; });
      let callbackSignal!: AbortSignal;
      let lateAnswer!: (value: { outcome: "allow_once" }) => void;
      const handler = vi.fn((_request, context) => {
        callbackSignal = context.signal; pending();
        return new Promise<{ outcome: "allow_once" }>(resolve => { lateAnswer = resolve; });
      });
      const turn = port.startTurn({ text: "Attempt one edit", requestId: "native-death-turn", onPermissionRequest: handler });
      const settled = expect(turn.result).rejects.toMatchObject({ code: "ACPX_PROVIDER_PROCESS_LOST" });
      const draining = expect((async () => { for await (const _event of turn.events) { /* drain */ } })())
        .rejects.toMatchObject({ code: "ACPX_PROVIDER_PROCESS_LOST" });
      const bounded = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Real native ACPX death remained unsettled")), 5_000);
      });
      await Promise.race([requested, bounded]);
      const nativePid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(nativePid) && nativePid > 0).toBe(true);
      process.kill(nativePid, "SIGKILL");
      await Promise.race([Promise.all([settled, draining]), bounded]);
      expect(callbackSignal.aborted).toBe(true);
      lateAnswer({ outcome: "allow_once" });
      expect(() => port!.startTurn({ text: "Replay", requestId: "replay" })).toThrow("provider exited");
      expect(handler).toHaveBeenCalledOnce();
      expect(() => process.kill(nativePid, 0)).toThrow();
    } finally {
      clearTimeout(deadline);
      await port?.close({ reason: "offline native-death fixture complete" });
      await owner.command.close();
      await Promise.all(fences.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    }
  }, 15_000);
});

const blockingCopilotPeer = String.raw`
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
require('node:fs').writeFileSync(process.env.NATIVE_TEST_PID_FILE,String(process.pid));
const mode='https://agentclientprotocol.com/protocol/session-modes#agent';
const config=[{id:'mode',name:'Mode',type:'select',currentValue:mode,options:[{value:mode,name:'Agent'}]},
 {id:'allow_all',name:'Allow all',type:'select',currentValue:'off',options:[{value:'off',name:'Off'}]},
 {id:'model',name:'Model',type:'select',currentValue:'gpt-5.6-luna',options:[{value:'gpt-5.6-luna',name:'Luna'}]}];
const snapshot={sessionId:'copilot-death-session',modes:{currentModeId:mode,availableModes:[{id:mode,name:'Agent'}]},configOptions:config,
 models:{currentModelId:'gpt-5.6-luna',availableModels:[{modelId:'gpt-5.6-luna',name:'Luna'}]}};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(['session/new','session/load'].includes(m.method))send({id:m.id,result:snapshot});
 else if(m.method==='session/set_model'||m.method==='session/close')send({id:m.id,result:{}});
 else if(m.method==='session/set_config_option')send({id:m.id,result:{configOptions:config}});
 else if(m.method==='session/prompt')send({id:'pending-edit',method:'session/request_permission',params:{sessionId:'copilot-death-session',
  toolCall:{toolCallId:'native-edit',title:'Write file',kind:'edit',status:'pending',rawInput:{path:'target.txt',content:'FORBIDDEN'}},
  options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
});`;

async function listen(): Promise<Server> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); return server;
}
