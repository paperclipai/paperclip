import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { open, copyFile, mkdir, readdir, realpath, chmod, lstat, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { createInterface } from "node:readline";
import type { Db } from "@paperclipai/db";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { HARNESS_PROTOCOL_SCHEMA, HARNESS_MAX_FRAME_BYTES, parseHarnessResponse,
  parseHarnessReleaseIdentity, sameRunnerHarnessRelease, type HarnessReleaseIdentity } from "@paperclipai/runner-sdk/contracts";
import { runnerHarnessRegistry, validateRunnerHarnessConfiguration, type ResolvedRunnerHarness } from "../runner-harness-registry.js";
import { NativeEnvironmentProbeCleanupError } from "../../vendor/paperclip-runner/index.js";

export interface ExtensionLaunchProfile {
  schema: "paperclip.harness-launch.v1";
  identity: HarnessReleaseIdentity;
  command: { path: string; sha256: string };
  entrypoint: { path: string; sha256: string };
  args: string[];
  environmentKeys: string[];
}

const remoteInventoryProbe = String.raw`
(async()=>{
 const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
 const [root,expected]=process.argv.slice(1),entries=[];let bytes=0;
 async function walk(dir,rel='',depth=0){
  if(depth>32)throw Error('depth');
  for(const name of (await fs.promises.readdir(dir)).sort()){
   const file=p.join(dir,name),key=rel?rel+'/'+name:name,s=await fs.promises.lstat(file);
   if(s.isSymbolicLink())throw Error('symlink');
   if(s.isDirectory())await walk(file,key,depth+1);
   else if(s.isFile()){
    bytes+=s.size;if(bytes>256*1024*1024||entries.length>=10000)throw Error('size');
    const f=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const hash=c.createHash('sha256');for await(const part of f.createReadStream({autoClose:false}))hash.update(part);
     entries.push([key,'sha256:'+hash.digest('hex'),s.mode&511]);}finally{await f.close();}
   }else throw Error('file');
  }
 }
 if(!p.isAbsolute(root)||(await fs.promises.lstat(root)).isSymbolicLink())throw Error('root');
 await walk(root);
 if('sha256:'+c.createHash('sha256').update(JSON.stringify(entries)).digest('hex')!==expected)throw Error('integrity');
 const command=await fs.promises.realpath(process.execPath),hash=c.createHash('sha256');
 const f=await fs.promises.open(command,'r');try{for await(const part of f.createReadStream({autoClose:false}))hash.update(part);}finally{await f.close();}
 process.stdout.write(JSON.stringify({command,sha256:'sha256:'+hash.digest('hex'),platform:process.platform+'-'+process.arch,node:process.versions.node}));
})().catch(()=>{process.stderr.write('Harness runtime integrity verification failed');process.exitCode=1;});`;

/** Stage a self-contained opt-in package, then verify its bytes on the execution host. */
export async function prepareRemoteRunnerHarness(input: {
  resolved: ResolvedRunnerHarness;
  profile: ExtensionLaunchProfile;
  targetRoot: string;
  runner: CommandManagedRuntimeRunner;
  stageDirectory(sourcePath: string, targetPath: string): Promise<void>;
}): Promise<ExtensionLaunchProfile> {
  await input.stageDirectory(input.resolved.packageRoot, input.targetRoot);
  const checked = await input.runner.execute({ command: "node", args: ["-e", remoteInventoryProbe,
    input.targetRoot, input.resolved.release.runtimeDigest], timeoutMs: 30_000, bypassSession: true });
  if (checked.exitCode !== 0 || checked.timedOut || checked.stdout.length > 4096) throw new Error("runner_extension_remote_integrity_invalid");
  const metadata = JSON.parse(checked.stdout) as { command: string; sha256: string; platform: string; node: string };
  if (!(input.resolved.declaration.platforms as readonly string[]).includes(metadata.platform)
    || !/^\/(?!$)/.test(metadata.command) || !/^sha256:[a-f0-9]{64}$/.test(metadata.sha256)
    || !/^\d+\.\d+\.\d+$/.test(metadata.node)
    || Number(metadata.node.split(".")[0]) < 24
    || (Number(metadata.node.split(".")[0]) === 24 && Number(metadata.node.split(".")[1]) < 11)) throw new Error("runner_extension_remote_platform_unsupported");
  return { ...input.profile, args: [JSON.stringify({ packageRoot: input.targetRoot, identity: input.resolved.release })], command: { path: metadata.command, sha256: metadata.sha256 },
    entrypoint: { path: input.targetRoot + "/" + input.resolved.declaration.runtime.entrypoint,
      sha256: input.resolved.declaration.runtime.sha256 } };
}

async function fileDigest(filename: string): Promise<string> {
  const file = await open(filename, "r");
  try {
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    return `sha256:${hash.digest("hex")}`;
  } finally { await file.close(); }
}

async function stageRuntimeFile(source: string, target: string, mode?: number): Promise<void> {
  const existing = await lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("runner_extension_runtime_file_invalid");
    if (await fileDigest(source) === await fileDigest(target)) {
      if (mode !== undefined) await chmod(target, mode);
      return;
    }
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (mode !== undefined) await chmod(temporary, mode);
    // Replacing the directory entry works for an existing read-only dylib and
    // leaves any process already mapping its old inode undisturbed.
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

/** Installation authorizes code; the agent configuration supplies data only. */
export async function prepareInstalledRunnerHarness(db: Db, input: {
  companyId: string;
  provider: { harnessId: string; release: HarnessReleaseIdentity; config: Record<string, unknown> };
  environment: NodeJS.ProcessEnv;
  launchDirectory?: string;
}): Promise<{ resolved: ResolvedRunnerHarness; profile: ExtensionLaunchProfile; credentialIdentity: string }> {
  const resolved = await runnerHarnessRegistry(db).resolve(input.companyId, input.provider.harnessId);
  if (!sameRunnerHarnessRelease(resolved.release, parseHarnessReleaseIdentity(input.provider.release))) {
    throw new Error("runner_extension_release_changed: restore the admitted package before resuming this session");
  }
  validateRunnerHarnessConfiguration(resolved, { extensionConfig: input.provider.config });
  const environmentKeys = (resolved.declaration.credentials ?? []).map(credential => {
    if (credential.required && !input.environment[credential.key]?.trim()) {
      throw new Error(`runner_extension_credential_required: ${credential.displayName}`);
    }
    return credential.key;
  });
  let commandPath = process.execPath;
  if (process.platform === "darwin") {
    // The existing macOS verifier creates its sealed executable beside the source.
    // Keep that write inside instance-owned runtime storage, including Node's
    // loader-relative libnode closure used by Homebrew installations.
    const source = await realpath(process.execPath);
    const directory = input.launchDirectory ?? join(resolvePaperclipInstanceRoot(), "runtime", "harness-node", resolved.release.runtimeDigest.slice(7));
    const bin = join(directory, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    commandPath = join(bin, "node");
    await stageRuntimeFile(source, commandPath, 0o700);
    const sourceLib = resolve(dirname(source), "../lib");
    for (const name of await readdir(sourceLib).catch(() => [] as string[])) {
      if (!/^libnode.*\.dylib$/.test(name)) continue;
      await mkdir(join(directory, "lib"), { recursive: true, mode: 0o700 });
      await stageRuntimeFile(join(sourceLib, name), join(directory, "lib", name));
    }
  }
  const credentialIdentity = `sha256:${createHash("sha256").update(JSON.stringify(environmentKeys.slice().sort()
    .map(key => [key, input.environment[key] ?? null]))).digest("hex")}`;
  return { resolved, credentialIdentity, profile: { schema: "paperclip.harness-launch.v1", identity: resolved.release,
    command: { path: commandPath, sha256: await fileDigest(commandPath) },
    entrypoint: { path: resolved.entrypoint, sha256: resolved.declaration.runtime.sha256 },
    args: [JSON.stringify({ packageRoot: resolved.packageRoot, identity: resolved.release })], environmentKeys } };
}

/** An explicit setup probe starts the selected package with no task or tool authority. */
export async function probeInstalledRunnerHarness(db: Db, context: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  const result = (status: AdapterEnvironmentTestResult["status"]) => ({
    adapterType: "paperclip_runner", status, testedAt: new Date().toISOString(), checks,
  });
  try {
    const resolved = await runnerHarnessRegistry(db).resolve(context.companyId, String(context.config.harnessId));
    const model = context.config.model;
    if (typeof model !== "string" || !model.trim()) throw new Error("Choose a model before testing the harness.");
    const config = context.config.extensionConfig as Record<string, unknown> ?? {};
    const environment = Object.fromEntries(Object.entries(context.config.env as Record<string, unknown> ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const { profile, credentialIdentity } = await prepareInstalledRunnerHarness(db, {
      companyId: context.companyId, provider: { harnessId: resolved.release.harnessId, release: resolved.release, config }, environment,
    });
    if (context.executionTarget?.kind === "remote") {
      const target = context.executionTarget;
      if (target.transport === "sandbox" && target.runnerTask) {
        const { probePluginRunnerEnvironment } = await import("./plugin-runner-probe.js");
        return await probePluginRunnerEnvironment(context, undefined, { resolved, credentialIdentity });
      }
      const runner = target.transport === "ssh"
        ? (await import("./native-ssh-command-runner.js")).createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd })
        : target.runner;
      if (!runner) throw new Error("The selected execution environment cannot probe an installed harness.");
      const targetRoot = target.remoteCwd + "/.paperclip-runtime/harness-probes/" + randomUUID();
      const { stageRemoteRunnerDirectory } = await import("./native-session-executor.js");
      const remoteProfile = await prepareRemoteRunnerHarness({ resolved, profile, runner, targetRoot,
        stageDirectory: (sourcePath, targetPath) => stageRemoteRunnerDirectory({
          target, runner, sourcePath, targetPath, mode: 0o555, preservePermissions: true }) });
      const provider = { kind: "extension", harnessId: resolved.release.harnessId, release: resolved.release,
        model, config, cwd: target.remoteCwd, runtimeDirectory: null, instructions: "", runtimeContext: null,
        readOnly: true, toolsDenied: true };
      const receipt = await probeRemoteHarnessProcess(remoteProfile, provider, environment, runner, targetRoot);
      if (!sameRunnerHarnessRelease(parseHarnessReleaseIdentity(receipt.identity), resolved.release)
        || receipt.effectiveModel !== model || receipt.probePassed !== true) throw new Error("The remote harness did not verify the selected account and model.");
      checks.push({ code: "runner_extension_probe_passed", level: "info", message: `Verified ${resolved.declaration.displayName} with model ${model} in the selected environment.` });
      return result("pass");
    }
    if (!(resolved.declaration.platforms as readonly string[]).includes(`${process.platform}-${process.arch}`)) throw new Error("This harness package does not support the local platform.");
    const provider = { kind: "extension", harnessId: resolved.release.harnessId, release: resolved.release,
      model, config, cwd: process.cwd(), runtimeDirectory: null, instructions: "", runtimeContext: null,
      readOnly: true, toolsDenied: true };
    const receipt = await probeHarnessProcess(profile, provider, environment);
    if (!sameRunnerHarnessRelease(parseHarnessReleaseIdentity(receipt.identity), resolved.release)
      || receipt.effectiveModel !== model || receipt.probePassed !== true) {
      throw new Error("The harness did not verify the selected release, account and model with tools denied.");
    }
    checks.push({ code: "runner_extension_probe_passed", level: "info", message: `Verified ${resolved.declaration.displayName} with model ${model}.` });
    return result("pass");
  } catch (error) {
    if (error instanceof NativeEnvironmentProbeCleanupError) throw error;
    // Provider exceptions and stderr may contain the selected account's credentials.
    checks.push({ code: "runner_extension_probe_failed", level: "error",
      message: "The installed harness could not verify the selected account and model. Check its credentials, configuration and package compatibility." });
    return result("fail");
  }
}

const remoteProcessProbe = String.raw`
(async()=>{
 const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),fs=require('node:fs');
 const spec=JSON.parse(process.argv[1]),selected=Object.fromEntries(spec.profile.environmentKeys.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]]]));
 fs.writeFileSync(spec.recordPath,JSON.stringify({nonce:spec.id,pid:null}),{mode:384,flag:'wx'});
 const child=spawn(spec.profile.command.path,[spec.profile.entrypoint.path,...spec.profile.args],{detached:true,env:selected,stdio:['pipe','pipe','pipe']});
 fs.writeFileSync(spec.recordPath,JSON.stringify({nonce:spec.id,pid:child.pid??null}),{mode:384});
 let closed=false;child.once('close',()=>{closed=true});child.once('error',()=>{closed=true});child.stderr.resume();
 const absent=()=>{if(!child.pid)return closed;try{process.kill(-child.pid,0);return false}catch(e){if(e.code==='ESRCH')return true;throw e}};
 const kill=s=>{try{if(child.pid)process.kill(-child.pid,s);}catch{}};
 process.once('SIGTERM',()=>kill('SIGKILL'));process.once('SIGINT',()=>kill('SIGKILL'));
 const lines=createInterface({input:child.stdout});let pending,seq=0,bytes=0;
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304){kill('SIGKILL');pending?.reject(Error('limit'));}});
 child.on('error',()=>pending?.reject(Error('spawn')));child.on('exit',()=>pending?.reject(Error('exit')));
 lines.on('line',line=>{try{const r=JSON.parse(line);if(r.schema!=='paperclip.harness.v1'||r.id!==pending?.id||r.ok!==true)throw Error('response');pending.resolve(r.result);}catch{pending?.reject(Error('protocol'));}});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,t=setTimeout(()=>reject(Error('timeout')),15000);pending={id,resolve:v=>{clearTimeout(t);resolve(v)},reject:e=>{clearTimeout(t);reject(e)}};child.stdin.write(JSON.stringify({schema:'paperclip.harness.v1',id,method,params})+'\n');});
 let receipt;
 try{receipt=await request('initialize',{identity:spec.profile.identity,runId:spec.id,normalizedSessionId:spec.id,provider:spec.provider,snapshot:null,probe:true});await request('close',{reason:'setup probe complete'});}
 finally{lines.close();child.stdin.end();kill('SIGTERM');const start=Date.now();let killed=false;
  while(!closed||!absent()){if(Date.now()-start>=1000&&!killed){kill('SIGKILL');killed=true}if(Date.now()-start>=4000)throw Error('retirement');await new Promise(r=>setTimeout(r,25));}
  fs.writeFileSync(spec.recordPath,JSON.stringify({nonce:spec.id,pid:child.pid,retired:true}),{mode:384});}
 process.stdout.write(JSON.stringify(receipt));
})().catch(()=>{process.stderr.write('Harness account probe failed');process.exitCode=1;});`;

// The wrapper may exit or its transport may close while a descendant still
// owns the process group. This second command proves retirement independently.
const remoteProcessCleanup = String.raw`
(async()=>{
 const fs=require('node:fs'),[recordPath,nonce,packageRoot]=process.argv.slice(1);
 const s=await fs.promises.lstat(recordPath);if(!s.isFile()||s.isSymbolicLink()||s.size>1024)throw Error('record');
 const record=JSON.parse(await fs.promises.readFile(recordPath,'utf8'));
 if(record.nonce!==nonce||!Number.isSafeInteger(record.pid)||record.pid<=0)throw Error('identity');
 const absent=()=>{try{process.kill(-record.pid,0);return false}catch(e){if(e.code==='ESRCH')return true;throw e}};
 const kill=signal=>{try{process.kill(-record.pid,signal)}catch(e){if(e.code!=='ESRCH')throw e}};
 if(record.retired!==true){const started=Date.now();kill('SIGTERM');let killed=false;
  while(!absent()){if(Date.now()-started>=1000&&!killed){kill('SIGKILL');killed=true}if(Date.now()-started>=4000)throw Error('retirement');await new Promise(r=>setTimeout(r,25));}
  await fs.promises.writeFile(recordPath,JSON.stringify({...record,retired:true}),{mode:384});}
 process.stdout.write(JSON.stringify({nonce,confirmed:true}));
})().catch(()=>{process.stderr.write('Harness process retirement remains unconfirmed');process.exitCode=1;});`;

const remoteProbeFilesCleanup = String.raw`
(async()=>{
 const fs=require('node:fs'),path=require('node:path'),[packageRoot,recordPath]=process.argv.slice(1);
 const writableDirectories=async(directory,isRoot=false)=>{
  let stat;try{stat=await fs.promises.lstat(directory)}catch(error){if(error.code==='ENOENT')return;throw error}
  if(stat.isSymbolicLink()||!stat.isDirectory()){if(isRoot)throw Error('root');return}
  const handle=await fs.promises.open(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{
   const verified=await handle.stat();if(!verified.isDirectory())throw Error('directory');
   await handle.chmod((verified.mode&0o7777)|0o200);
   for(const entry of await fs.promises.readdir(directory,{withFileTypes:true})){
    if(entry.isDirectory()&&!entry.isSymbolicLink())await writableDirectories(path.join(directory,entry.name));
   }
  }finally{await handle.close()}
 };
 await writableDirectories(packageRoot,true);
 await fs.promises.rm(packageRoot,{recursive:true,force:true});
 await fs.promises.rm(recordPath,{force:true});
})().catch(()=>{process.exitCode=1});`;

function retainedProbeCleanup(operationError: unknown, cleanupError: unknown, cleanup: () => Promise<void>) {
  let running: Promise<void> | undefined;
  const retryCleanup = () => running ??= cleanup().finally(() => { running = undefined; });
  const retired = retryCleanup();
  void retired.catch(() => undefined);
  return new NativeEnvironmentProbeCleanupError(retired, operationError, [cleanupError], retryCleanup);
}

async function probeRemoteHarnessProcess(profile: ExtensionLaunchProfile, provider: Record<string, unknown>, environment: NodeJS.ProcessEnv, runner: CommandManagedRuntimeRunner, packageRoot: string) {
  const selected = Object.fromEntries(profile.environmentKeys.flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]!] ]));
  const id = `probe-${randomUUID()}`;
  const recordPath = `${packageRoot}.process.json`;
  let retired = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    if (!retired) {
      const proof = await runner.execute({ command: profile.command.path, args: ["-e", remoteProcessCleanup, recordPath, id, packageRoot],
        timeoutMs: 6000, bypassSession: true });
      if (proof.exitCode !== 0 || proof.timedOut || proof.stdout.length > 1024) throw new Error("Remote harness retirement remains unconfirmed");
      const receipt = JSON.parse(proof.stdout);
      if (receipt.nonce !== id || receipt.confirmed !== true) throw new Error("Remote harness retirement proof is invalid");
      retired = true;
    }
    const removed = await runner.execute({ command: profile.command.path, args: ["-e", remoteProbeFilesCleanup, packageRoot, recordPath],
      timeoutMs: 6000, bypassSession: true });
    if (removed.exitCode !== 0 || removed.timedOut) throw new Error("Remote harness probe files remain pending cleanup");
    cleaned = true;
  };
  let operationError: unknown;
  try {
    const response = await runner.execute({ command: profile.command.path,
      args: ["-e", remoteProcessProbe, JSON.stringify({ profile, provider, id, recordPath })],
      env: selected, timeoutMs: 35_000, bypassSession: true });
    if (response.exitCode !== 0 || response.timedOut || response.stdout.length > HARNESS_MAX_FRAME_BYTES) throw new Error("Remote harness probe failed");
    return JSON.parse(response.stdout) as Record<string, unknown>;
  } catch (error) { operationError = error; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) { throw retainedProbeCleanup(operationError, error, cleanup); }
  }
}

async function probeHarnessProcess(profile: ExtensionLaunchProfile, provider: Record<string, unknown>, environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (process.platform === "win32") throw new Error("Local harness probes require process group retirement support");
  const selected = Object.fromEntries(profile.environmentKeys.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]!]]));
  const child = spawn(profile.command.path, [profile.entrypoint.path, ...profile.args], {
    detached: true, env: selected, stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  child.once("close", () => { closed = true; }); child.once("error", () => { closed = true; });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let pending: { id: number; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | null = null;
  let bytes = 0;
  const fail = () => pending?.reject(new Error("Harness probe protocol failed"));
  child.on("error", fail); child.on("exit", fail);
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > HARNESS_MAX_FRAME_BYTES * 4) { fail(); child.kill(); } });
  lines.on("line", line => {
    try {
      if (Buffer.byteLength(line) > HARNESS_MAX_FRAME_BYTES) throw new Error("Frame exceeds limit");
      const response = parseHarnessResponse(JSON.parse(line));
      if (!pending || response.id !== pending.id) throw new Error("Unexpected response");
      const current = pending; pending = null;
      if (response.ok) current.resolve(response.result);
      else current.reject(new Error("Harness rejected probe"));
    } catch { fail(); }
  });
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => reject(new Error("Harness probe timed out")), 15_000);
    pending = { id, resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
    child.stdin.write(JSON.stringify({ schema: HARNESS_PROTOCOL_SCHEMA, id, method, params }) + "\n", error => { if (error) pending?.reject(error); });
  });
  const cleanup = async () => {
    const absent = () => {
      if (!child.pid) return closed;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const started = Date.now();
    kill("SIGTERM");
    let killed = false;
    while (!closed || !absent()) {
      if (Date.now() - started >= 1000 && !killed) { kill("SIGKILL"); killed = true; }
      if (Date.now() - started >= 4000) throw new Error("Harness process group retirement remains unconfirmed");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  let operationError: unknown;
  try {
    const receipt = await request("initialize", { identity: profile.identity, runId: `probe-${randomUUID()}`,
      normalizedSessionId: `probe-${randomUUID()}`, provider, snapshot: null, probe: true });
    await request("close", { reason: "setup probe complete" });
    return receipt;
  } catch (error) { operationError = error; throw error; }
  finally {
    lines.close(); child.stdin.end();
    try { await cleanup(); }
    catch (error) { throw retainedProbeCleanup(operationError, error, cleanup); }
  }
}
