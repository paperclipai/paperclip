import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parseRunnerHarnessCheckpoint, sameRunnerHarnessRelease, type RunnerHarnessCheckpoint } from "@paperclipai/runner-sdk/contracts";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fail(): never { throw new Error("runner_extension_checkpoint_source_unproven"); }

/** Retain prior Runner files as proof; only the provider home may be restored. */
export async function prepareRemoteExtensionCheckpoint(input: {
  checkpoint: RunnerHarnessCheckpoint;
  backup: { root: string; manifest: { normalizedSessionId: string; runnerInstanceId: string;
    sourceProviderLeaseId: string; directories: Array<{ name: string; sha256: string; bytes: number }> } };
  currentRunId: string;
  checkpointSourceRunId: string;
  remoteSessionRoot: string;
  remoteStateDirectory: string;
  remoteHomeDirectory: string;
  acquisitionOutcome: "created" | "resumed" | "replacement" | null;
  currentProviderLeaseId?: string;
  runner: Pick<CommandManagedRuntimeRunner, "execute">;
  restoreHome(source: string, target: string): Promise<void>;
}): Promise<void> {
  const checkpoint = parseRunnerHarnessCheckpoint(input.checkpoint);
  const read = (name: string) => {
    const filename = join(input.backup.root, "runner", name);
    if (statSync(filename).size > 32 * 1024 * 1024) fail();
    const bytes = readFileSync(filename);
    return { value: record(JSON.parse(bytes.toString("utf8"))), digest: digest(bytes) };
  };
  const runner = read("runner-state.json"), provider = read("extension-provider-state.json");
  const state = provider.value, descriptor = record(state.provider), ids = record(state.providerSessionIdentity);
  const nativeIds = checkpoint.providerSessionIdentity;
  const sourceRunId = runner.value.runId;
  const home = input.backup.manifest.directories.find(directory => directory.name === "extension");
  if (!nativeIds || !home || !/^sha256:[a-f0-9]{64}$/.test(home.sha256)
    || input.backup.manifest.normalizedSessionId !== checkpoint.normalizedSessionId
    || !input.backup.manifest.sourceProviderLeaseId || input.backup.manifest.sourceProviderLeaseId === "unknown"
    || runner.value.schema !== "paperclip.runner.durable.state.v1" || runner.value.lifecycle !== "suspended"
    || runner.value.runnerInstanceId !== input.backup.manifest.runnerInstanceId
    || runner.value.normalizedSessionId !== checkpoint.normalizedSessionId
    || !Array.isArray(runner.value.outbox) || runner.value.outbox.length !== 0
    || runner.value.pendingTerminalDelivery != null
    || typeof sourceRunId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(sourceRunId)
    || sourceRunId === input.currentRunId || sourceRunId !== input.checkpointSourceRunId
    || state.schema !== "paperclip.harness-state.v1" || state.sessionId !== checkpoint.normalizedSessionId
    || state.runId !== sourceRunId || state.activeTurn !== false || state.processGroup !== null
    || !Array.isArray(state.events) || state.events.length !== 0
    || !state.pendingRequests || Array.isArray(state.pendingRequests) || typeof state.pendingRequests !== "object"
    || Object.keys(state.pendingRequests).length !== 0
    || canonical(ids) !== canonical(nativeIds)
    || !sameRunnerHarnessRelease(checkpoint.identity, state.identity as RunnerHarnessCheckpoint["identity"])
    || descriptor.kind !== "extension" || descriptor.model !== checkpoint.model
    || canonical(descriptor.config) !== canonical(checkpoint.config)
    || descriptor.accountIdentity !== checkpoint.accountIdentity || descriptor.credentialIdentity !== checkpoint.credentialIdentity
    || descriptor.runtimeDirectory !== input.remoteHomeDirectory || checkpoint.runtimeDirectory !== input.remoteHomeDirectory) fail();
  const resumed = input.acquisitionOutcome === "resumed" || input.acquisitionOutcome === null;
  if (resumed && input.currentProviderLeaseId && input.currentProviderLeaseId !== input.backup.manifest.sourceProviderLeaseId) fail();
  const spec = { current: input.remoteStateDirectory, home: input.remoteHomeDirectory,
    source: posix.join(input.remoteSessionRoot, "runner", sourceRunId), runnerDigest: runner.digest,
    providerDigest: provider.digest, homeDigest: home.sha256, homeBytes: home.bytes, resumed };
  const execute = async (phase: "before" | "after") => {
    const result = await input.runner.execute({ command: "node", args: ["-e", inspectExtensionCheckpoint, JSON.stringify({ ...spec, phase })],
      bypassSession: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) fail();
  };
  await execute("before");
  if (!resumed) await input.restoreHome(join(input.backup.root, "extension"), input.remoteHomeDirectory);
  await execute("after");
}

// This runs in the selected execution environment. The previous epoch proves
// settlement; its journal is never copied into the new epoch's directory.
const inspectExtensionCheckpoint = String.raw`
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),s=JSON.parse(process.argv[1]);
const hash=b=>'sha256:'+c.createHash('sha256').update(b).digest('hex');
const safe=f=>{if(!p.isAbsolute(f)||fs.lstatSync(f).isSymbolicLink())throw Error('path');};
try{
 if(fs.existsSync(s.current)){safe(s.current);if(!fs.statSync(s.current).isDirectory()||fs.readdirSync(s.current).length)throw Error('epoch');}
 if(s.phase==='before'&&!s.resumed){if(fs.existsSync(s.home))throw Error('home');process.exit(0);}
 if(s.resumed){for(const [name,expected] of [['runner-state.json',s.runnerDigest],['extension-provider-state.json',s.providerDigest]]){
  const f=p.join(s.source,name);safe(f);if(hash(fs.readFileSync(f))!==expected)throw Error('source');}}
 safe(s.home);if(!fs.statSync(s.home).isDirectory())throw Error('home');
 const h=c.createHash('sha256');let bytes=0;
 const walk=(dir,relative)=>{const names=fs.readdirSync(dir).sort((a,b)=>a.localeCompare(b));if(!names.length)h.update('directory:'+relative+'\0');
 for(const name of names){const f=p.join(dir,name),r=relative?relative+'/'+name:name,st=fs.lstatSync(f);
 if(st.isDirectory()){h.update('directory:'+r+':'+(st.mode&511)+'\0');walk(f,r);}
 else if(st.isFile()){const b=fs.readFileSync(f);bytes+=b.length;h.update('file:'+r+':'+(st.mode&511)+':'+b.length+'\0');h.update(b);}
 else throw Error('entry');}};
 walk(s.home,'');if('sha256:'+h.digest('hex')!==s.homeDigest||bytes!==s.homeBytes)throw Error('contents');
}catch{process.stderr.write('Extension checkpoint proof failed');process.exitCode=1;}
`;
