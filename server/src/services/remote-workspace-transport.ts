import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { RemoteWorkspaceSource } from "@paperclipai/shared";
import { remoteWorkspaceArchiveScript } from "./remote-workspace-snapshot-archive.js";
import type { GitRemoteAuthProvider } from "./git-credentials.js";

export type RemoteWorkspaceTarget = Extract<AdapterExecutionTarget, { transport: "sandbox" }>;

export function requireRemoteWorkspaceTarget(target: AdapterExecutionTarget | null): RemoteWorkspaceTarget {
  if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner || target.runnerTask
    || !target.runner.syncIn || !target.runner.syncOut) throw new Error("remote_workspace_transport_unsupported");
  return target;
}

async function command(target: RemoteWorkspaceTarget, args: string[], env?: Record<string, string>) {
  const result = await target.runner!.execute({ command: "node", args, cwd: target.remoteCwd,
    env: { NODE_OPTIONS: "", NODE_PATH: "", ...env }, timeoutMs: 300_000, bypassSession: true });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("remote_workspace_operation_failed");
  return result.stdout;
}

const PREPARE = String.raw`
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process');
const {promisify}=require('node:util'); const exec=promisify(cp.execFile);
(async()=>{
 const [root,raw]=process.argv.slice(1), input=JSON.parse(raw);
 if (!path.isAbsolute(root)) throw Error('invalid_root');
 let current='/'; for(const part of root.split('/').filter(Boolean)) {
  current=path.join(current,part); await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
  const s=await fs.lstat(current); if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_root');
 }
 if ((await fs.readdir(root)).length) throw Error('workspace_not_empty');
 if(input.kind==='git'){
  await exec('git',[...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,root],{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  if(input.ref)await exec('git',['-c','core.hooksPath=/dev/null','-C',root,'checkout','--detach',input.ref]);
  if(input.branchName)await exec('git',['-c','core.hooksPath=/dev/null','-C',root,'checkout','-B',input.branchName]);
  await fs.appendFile(path.join(root,'.git','info','exclude'),'\n/.paperclip-runtime/\n/.paperclip-repositories/\n');
 }
 process.stdout.write(JSON.stringify({cwd:await fs.realpath(root)}));
})().catch(()=>{process.stderr.write('remote_workspace_prepare_failed');process.exitCode=1});`;

export async function prepareRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; source: RemoteWorkspaceSource; resolveGitAuth: GitRemoteAuthProvider;
}) {
  const auth = input.source.kind === "git" ? await input.resolveGitAuth(input.source.repoUrl) : null;
  const output = await command(input.target, ["-e", PREPARE, input.remoteCwd,
    JSON.stringify({ ...input.source, authArgs: auth?.configArgs ?? [] })], auth?.env);
  const result = JSON.parse(output) as { cwd: string };
  if (result.cwd !== input.remoteCwd) throw new Error("remote_workspace_root_changed");
}

export function remoteWorkspaceRepositoryPath(remoteRoot: string, repository: {
  id: string; relativePath: string; readOnly?: boolean;
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(repository.id) || path.posix.isAbsolute(repository.relativePath)
    || repository.relativePath.split("/").some(part => !part || part === "." || part === "..")
    || /[\\\u0000-\u001f]/u.test(repository.relativePath)) throw new Error("remote_workspace_repository_path_invalid");
  return repository.readOnly
    ? path.posix.join(path.posix.dirname(remoteRoot), ".paperclip-referenced", path.posix.basename(remoteRoot), repository.id)
    : path.posix.join(remoteRoot, repository.relativePath);
}

export async function prepareRemoteRepository(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; repoUrl: string; ref: string | null;
  pinnedCommit?: string; verifyOnly?: boolean; resolveGitAuth: GitRemoteAuthProvider;
}) {
  const auth = await input.resolveGitAuth(input.repoUrl);
  const script = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(cp.execFile);
  (async()=>{const [root,raw]=process.argv.slice(1),input=JSON.parse(raw);const opts={env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}};
  const existing=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(existing){if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('unsafe_repository')}
  else{if(input.verifyOnly)throw Error('repository_missing');await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});await exec('git',[...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,root],opts);
   if(input.ref)await exec('git',['-c','core.hooksPath=/dev/null','-C',root,'checkout','--detach',input.ref],opts);}
  const git=async args=>(await exec('git',['-c','core.hooksPath=/dev/null','-C',root,...args],opts)).stdout.trim();
  if(await fs.realpath(root)!==root)throw Error('unsafe_repository');
  const origin=await git(['remote','get-url','origin']);if(origin!==input.repoUrl)throw Error('repository_origin_changed');
  const head=await git(['rev-parse','HEAD']);if(input.pinnedCommit&&head!==input.pinnedCommit)throw Error('repository_pin_changed');
  const branch=await git(['symbolic-ref','--short','-q','HEAD']).catch(()=>null);process.stdout.write(JSON.stringify({cwd:root,pinnedCommit:head,branchName:branch}));
  })().catch(()=>{process.stderr.write('remote_workspace_repository_failed');process.exitCode=1});`;
  const output = await command(input.target, ["-e", script, input.remoteCwd,
    JSON.stringify({ ...input, target: undefined, resolveGitAuth: undefined, authArgs: auth?.configArgs ?? [] })], auth?.env);
  const value = JSON.parse(output) as { cwd: string; pinnedCommit: string; branchName: string | null };
  if (value.cwd !== input.remoteCwd || !/^[a-f0-9]{40,64}$/.test(value.pinnedCommit)) throw new Error("remote_workspace_repository_receipt_invalid");
  return value;
}

async function installArchiveHelper(target: RemoteWorkspaceTarget, remoteCwd: string, operationId: string) {
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("remote_workspace_operation_identity_invalid");
  const directory = path.posix.join(remoteCwd, ".paperclip-runtime", "workspace-snapshots", operationId);
  const helper = path.posix.join(directory, "archive.cjs");
  const install = String.raw`const fs=require('node:fs/promises'),path=require('node:path');(async()=>{
   const [root,dir,file,body]=process.argv.slice(1);let p='/';
   for(const s of root.split('/').filter(Boolean)){p=path.join(p,s);await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe');}
   for(const s of path.relative(root,dir).split('/')){p=path.join(p,s);await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe');}
   const existing=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e});if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw Error('unsafe');
   const temp=file+'.'+require('node:crypto').randomUUID()+'.tmp';await fs.writeFile(temp,Buffer.from(body,'base64'),{mode:0o600,flag:'wx'});await fs.rename(temp,file);
  })().catch(()=>{process.exitCode=1});`;
  await command(target, ["-e", install, remoteCwd, directory, helper, Buffer.from(remoteWorkspaceArchiveScript()).toString("base64")]);
  return { directory, helper, archive: path.posix.join(directory, "workspace.pcws"), receipt: path.posix.join(directory, "receipt.json") };
}

export async function captureRemoteWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string;
}) {
  const staged = await installArchiveHelper(input.target, input.remoteCwd, input.operationId);
  // A completed immutable export belongs to this operation and survives controller loss.
  const capture = String.raw`const fs=require('node:fs/promises'),cp=require('node:child_process');const {promisify}=require('node:util');(async()=>{
   const [helper,root,archive,receipt]=process.argv.slice(1);let result;
   try{result=JSON.parse(await fs.readFile(receipt,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;
    await fs.rm(archive,{force:true});
    const r=await promisify(cp.execFile)(process.execPath,[helper,'capture',root,archive],{maxBuffer:1048576});result=JSON.parse(r.stdout);
    const temp=receipt+'.tmp';await fs.writeFile(temp,JSON.stringify(result),{mode:0o600});await fs.rename(temp,receipt);}
   process.stdout.write(JSON.stringify(result));
  })().catch(()=>{process.stderr.write('remote_workspace_capture_failed');process.exitCode=1});`;
  const receipt = JSON.parse(await command(input.target, ["-e", capture, staged.helper, input.remoteCwd, staged.archive, staged.receipt])) as {
    manifestDigest: string; sha256: string; byteSize: number; entries: number;
  };
  if (!/^[a-f0-9]{64}$/.test(receipt.manifestDigest) || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) throw new Error("remote_workspace_capture_receipt_invalid");
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-upload-"));
  const archivePath = path.join(root, "workspace.pcws");
  try {
    await input.target.runner!.syncOut!([{ operationId: input.operationId,
      files: [{ kind: "file", sourcePath: staged.archive, targetPath: archivePath }],
    }]);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(archivePath)) { hash.update(chunk); bytes += chunk.length; }
    if (hash.digest("hex") !== receipt.sha256 || bytes !== receipt.byteSize) throw new Error("remote_workspace_capture_transfer_mismatch");
    return { ...receipt, archivePath, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function restoreRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; archivePath: string; manifestDigest: string;
}) {
  const operationId = randomUUID();
  // Stage outside the destination; the restore validator requires an empty target.
  const parent = path.posix.dirname(input.remoteCwd);
  const staged = await installArchiveHelper(input.target, parent, operationId);
  await input.target.runner!.syncIn!([{ operationId,
    files: [{ kind: "file", sourcePath: input.archivePath, targetPath: staged.archive }],
  }]);
  await command(input.target, [staged.helper, "restore", staged.archive, input.remoteCwd, input.manifestDigest]);
}
