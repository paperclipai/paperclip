// Shared fixtures for the native ACPX closure and verified-store tests.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, vi } from "vitest";
import { copyOwnedNodeRuntime } from "../../test-support/owned-node-runtime.js";
import { NATIVE_ACPX_STORE_ROOT_ENV, readNativeAcpxDistributionEntries, type NativeAcpxDistributionInput, type NativeAcpxDistributionEntry } from "./native-distribution-integrity.js";

/** Every test verifies into its own empty store; fixtures repeat closure pins. */
export function useNativeStoreFixtures(): void {
  const previousStoreRoot = process.env[NATIVE_ACPX_STORE_ROOT_ENV];
  beforeEach(async () => { storeRoot = await realpath(await mkdtemp(join(tmpdir(), "native-acpx-store-"))); process.env[NATIVE_ACPX_STORE_ROOT_ENV] = storeRoot; });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousStoreRoot === undefined) delete process.env[NATIVE_ACPX_STORE_ROOT_ENV]; else process.env[NATIVE_ACPX_STORE_ROOT_ENV] = previousStoreRoot;
    await Promise.all([...roots.splice(0), storeRoot].map(root => unsealAndRemove(root)));
  });
}

export const roots: string[] = [];
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function unsealAndRemove(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await chmod(directory, 0o700).catch(() => undefined);
    for (const child of await readdir(directory, { withFileTypes: true }).catch(() => [])) if (child.isDirectory()) pending.push(join(directory, child.name));
  }
  await rm(root, { recursive: true, force: true });
}
export let storeRoot = "";
/** Private per-launch directory, from its first creation after `start`. */
export function launchRootSince(start: number): string {
  const created = vi.mocked(mkdir).mock.calls.slice(start).map(([path]) => String(path)).find(path => path.includes("paperclip-acpx-native-"));
  return dirname(created!);
}
/** Staging distribution root of the store built after `start`. */
export function stagingRootSince(start: number): string {
  return vi.mocked(mkdir).mock.calls.slice(start).map(([path]) => String(path)).find(path => /\/\.staging-[^/]+\/distribution$/.test(path))!;
}

export async function fixture(options: { node?: boolean; script?: string } = {}): Promise<NativeAcpxDistributionInput> {
  const root = await mkdtemp(join(tmpdir(), "native-acpx-test-")); roots.push(root);
  const entries: NativeAcpxDistributionEntry[] = [];
  if (options.node) {
    const { executable, libraries } = await copyOwnedNodeRuntime(root);
    const bytes = await readFile(executable); entries.push({ path: "runtime", sha256: hash(bytes), size: bytes.length, executable: true });
    for (const libraryPath of libraries) {
      const library = await readFile(libraryPath); entries.push({ path: libraryPath.slice(root.length + 1), sha256: hash(library), size: library.length, executable: false });
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
export async function manyFileFixture(sizes: number[]) {
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
export async function directoryFixture() {
  const declaration = await fixture();
  const entries = await readNativeAcpxDistributionEntries(declaration);
  for (let index = 0; index < 40; index++) {
    const parent = `dir-${String(index).padStart(2, "0")}/nested`;
    await mkdir(join(declaration.distributionRoot, parent), { recursive: true });
    for (const name of ["a", "b"]) {
      const path = `${parent}/${name}`; const bytes = Buffer.from(path);
      await writeFile(join(declaration.distributionRoot, path), bytes, { mode: 0o600 });
      entries.push({ path, sha256: hash(bytes), size: bytes.length, executable: false });
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeFile(declaration.manifestPath, JSON.stringify({ entries }));
  return { declaration: { ...declaration, expectedClosureSha256: hash(JSON.stringify(entries)) }, entries };
}
export async function filePrototype(path: string): Promise<FileHandle> {
  const probe = await open(path, "r"); const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close(); return prototype;
}
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function output(child: ChildProcess): Promise<{ text: string; error: string; code: number | null }> {
  let text = ""; let error = "";
  child.stdout!.on("data", value => { text += String(value); });
  child.stderr!.on("data", value => { error += String(value); });
  const [code] = await once(child, "close") as [number | null];
  return { text, error, code };
}

export const blockingCopilotPeer = String.raw`
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

export async function listen(): Promise<Server> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); return server;
}
