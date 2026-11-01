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

async function command(target: RemoteWorkspaceTarget, args: string[], env?: Record<string, string>, timeoutMs = 300_000) {
  const result = await target.runner!.execute({ command: "node", args, cwd: target.remoteCwd,
    env: { NODE_OPTIONS: "", NODE_PATH: "", ...env }, timeoutMs, bypassSession: true });
  if (result.exitCode !== 0 || result.timedOut) {
    const gitOperation = "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace";
    throw new Error(!result.timedOut && result.stderr.trim() === gitOperation ? gitOperation : "remote_workspace_operation_failed");
  }
  return result.stdout;
}

const PREPARE = String.raw`
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process');
const {promisify}=require('node:util'); const exec=promisify(cp.execFile);
(async()=>{
 const [root,raw]=process.argv.slice(1), input=JSON.parse(raw);
 if (!path.isAbsolute(root)||!/^[a-f0-9]{64}$/.test(input.preparationIdentity)) throw Error('invalid_root');
 const noConfig={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_CONFIG_PARAMETERS:'',GIT_TEMPLATE_DIR:'',GIT_ASKPASS:'',SSH_ASKPASS:''};
 const isolated={...process.env,...noConfig};for(const key of Object.keys(isolated))if(/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))delete isolated[key];
 const cloneEnv={...isolated};for(const key of input.authEnvKeys)if(/^GIT_CONFIG_(COUNT|(KEY|VALUE)_\d+)$/.test(key)&&process.env[key]!==undefined)cloneEnv[key]=process.env[key];
 const localEnv={...isolated};for(const key of input.authEnvKeys)delete localEnv[key];Object.assign(localEnv,noConfig);
 let current='/'; for(const part of path.dirname(root).split('/').filter(Boolean)) {
  current=path.join(current,part); await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
  const s=await fs.lstat(current); if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_root');
 }
 const prior=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
 if(prior){
  if(!prior.isDirectory()||prior.isSymbolicLink()||await fs.realpath(root)!==root)throw Error('unsafe_root');
  const runtime=path.join(root,'.paperclip-runtime'),marker=path.join(runtime,'workspace-ready.json');
  const dir=await fs.lstat(runtime);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('unsafe_receipt');
  const file=await fs.lstat(marker);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>16384)throw Error('unsafe_receipt');
  if(JSON.parse(await fs.readFile(marker,'utf8')).preparationIdentity!==input.preparationIdentity)throw Error('workspace_owner_changed');
  process.stdout.write(JSON.stringify({cwd:root}));return;
 }
 if(input.probeOnly){process.stdout.write(JSON.stringify({cloneRequired:true}));return;}
 const staged=await fs.mkdtemp(root+'.preparing-');
 if(input.kind==='git'){
  await exec('git',['-c','core.hooksPath=/dev/null','-c','init.templateDir=',...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,staged],{env:cloneEnv});
  const git=async args=>exec('git',['-c','core.hooksPath=/dev/null','-C',staged,...args],{env:localEnv});
  if(input.branchMode==='existing'){
   if(!input.branchName)throw Error('existing_branch_required');
   await git(['check-ref-format','--branch',input.branchName]);
   const remoteRef='refs/remotes/origin/'+input.branchName;
   await git(['rev-parse','--verify','--quiet',remoteRef+'^{commit}']);
   const local=await git(['show-ref','--verify','--quiet','refs/heads/'+input.branchName]).then(()=>true,()=>false);
   await git(local?['checkout',input.branchName]:['checkout','-b',input.branchName,remoteRef]);
  }else{
   if(input.ref)await git(['checkout','--detach',input.ref]);
   if(input.branchName)await git(['checkout','-B',input.branchName]);
  }
  await fs.mkdir(path.join(staged,'.git','info'),{recursive:true,mode:0o700});
  await fs.appendFile(path.join(staged,'.git','info','exclude'),'\n/.paperclip-runtime/\n/.paperclip-repositories/\n');
 }else{
  await fs.writeFile(path.join(staged,'.gitignore'),'/.paperclip-runtime/\n/.paperclip-repositories/\n',{flag:'wx',mode:0o600});
 }
 const runtime=path.join(staged,'.paperclip-runtime');await fs.mkdir(runtime,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
 const runtimeStat=await fs.lstat(runtime);if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink())throw Error('unsafe_receipt');
 await fs.writeFile(path.join(runtime,'workspace-ready.json'),JSON.stringify({preparationIdentity:input.preparationIdentity}),{flag:'wx',mode:0o600});
 if(await fs.realpath(path.dirname(root))!==path.dirname(root))throw Error('unsafe_root');
 await fs.rename(staged,root);
 process.stdout.write(JSON.stringify({cwd:await fs.realpath(root)}));
})().catch(()=>{process.stderr.write('remote_workspace_prepare_failed');process.exitCode=1});`;

export async function prepareRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; source: RemoteWorkspaceSource; resolveGitAuth: GitRemoteAuthProvider;
  preparationIdentity: string;
}) {
  if (input.source.kind === "git") {
    const prior = JSON.parse(await command(input.target, ["-e", PREPARE, input.remoteCwd,
      JSON.stringify({ ...input.source, preparationIdentity: input.preparationIdentity,
        authArgs: [], authEnvKeys: [], probeOnly: true })])) as { cwd?: string; cloneRequired?: boolean };
    if (prior.cwd === input.remoteCwd) return;
    if (prior.cloneRequired !== true) throw new Error("remote_workspace_root_changed");
  }
  const auth = input.source.kind === "git" ? await input.resolveGitAuth(input.source.repoUrl) : null;
  const output = await command(input.target, ["-e", PREPARE, input.remoteCwd,
    JSON.stringify({ ...input.source, preparationIdentity: input.preparationIdentity,
      authArgs: auth?.configArgs ?? [], authEnvKeys: Object.keys(auth?.env ?? {}) })], auth?.env);
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
  pinnedCommit?: string; verifyOnly?: boolean; savedArchive?: boolean; resolveGitAuth: GitRemoteAuthProvider;
}) {
  const script = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(cp.execFile);
  (async()=>{const [root,raw]=process.argv.slice(1),input=JSON.parse(raw);const noConfig={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_CONFIG_PARAMETERS:'',GIT_TEMPLATE_DIR:'',GIT_ASKPASS:'',SSH_ASKPASS:''};
  const env={...process.env,...noConfig};for(const key of Object.keys(env))if(/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))delete env[key];
  const cloneEnv={...env};for(const key of input.authEnvKeys)if(/^GIT_CONFIG_(COUNT|(KEY|VALUE)_\d+)$/.test(key)&&process.env[key]!==undefined)cloneEnv[key]=process.env[key];
  const localEnv={...env};for(const key of input.authEnvKeys)delete localEnv[key];Object.assign(localEnv,noConfig);const opts={env:localEnv};
  let parent='/';for(const part of path.dirname(root).split('/').filter(Boolean)){parent=path.join(parent,part);
   await fs.mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const entry=await fs.lstat(parent);
   if(!entry.isDirectory()||entry.isSymbolicLink()||await fs.realpath(parent)!==parent)throw Error('unsafe_repository_parent');}
  const existing=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(existing){if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('unsafe_repository')}
  else{if(input.verifyOnly||input.savedArchive)throw Error('repository_missing');if(input.probeOnly){process.stdout.write(JSON.stringify({cloneRequired:true}));return;}await exec('git',['-c','core.hooksPath=/dev/null','-c','init.templateDir=',...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,root],{env:cloneEnv});
   if(input.ref)await exec('git',['-c','core.hooksPath=/dev/null','-C',root,'checkout','--detach',input.ref],opts);}
  const git=async args=>(await exec('git',['-c','core.hooksPath=/dev/null','-C',root,...args],opts)).stdout.trim();
  if(await fs.realpath(root)!==root)throw Error('unsafe_repository');
  const hasOrigin=(await git(['remote'])).split('\n').includes('origin');
  const origin=hasOrigin?await git(['remote','get-url','origin']):null;
  if(origin!==input.repoUrl&&!(input.savedArchive&&origin===null))throw Error('repository_origin_changed');
  const head=await git(['rev-parse','HEAD']);if(input.pinnedCommit)await git(['cat-file','-e',input.pinnedCommit+'^{commit}']);
  const branch=await git(['symbolic-ref','--short','-q','HEAD']).catch(()=>null);process.stdout.write(JSON.stringify({cwd:root,pinnedCommit:input.pinnedCommit||head,branchName:branch}));
  })().catch(()=>{process.stderr.write('remote_workspace_repository_failed');process.exitCode=1});`;
  const payload = { ...input, target: undefined, resolveGitAuth: undefined };
  const prior = JSON.parse(await command(input.target, ["-e", script, input.remoteCwd,
    JSON.stringify({ ...payload, authArgs: [], authEnvKeys: [], probeOnly: true })])) as {
      cwd?: string; pinnedCommit?: string; branchName?: string | null; cloneRequired?: boolean;
    };
  if (prior.cloneRequired !== true) {
    if (prior.cwd !== input.remoteCwd || !/^[a-f0-9]{40,64}$/.test(prior.pinnedCommit ?? "")) throw new Error("remote_workspace_repository_receipt_invalid");
    return { cwd: prior.cwd, pinnedCommit: prior.pinnedCommit!, branchName: prior.branchName ?? null };
  }
  const auth = await input.resolveGitAuth(input.repoUrl);
  const output = await command(input.target, ["-e", script, input.remoteCwd,
    JSON.stringify({ ...payload, authArgs: auth?.configArgs ?? [], authEnvKeys: Object.keys(auth?.env ?? {}) })], auth?.env);
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

/** Only immutable operation staging is removed; working files are never a target. */
export async function cleanupRemoteWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string;
}) {
  if (!/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("remote_workspace_operation_identity_invalid");
  const script = String.raw`const fs=require('node:fs/promises'),path=require('node:path');(async()=>{
   const [root,id]=process.argv.slice(1);if(!path.isAbsolute(root)||!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid');
   const dir=path.join(root,'.paperclip-runtime','workspace-snapshots',id);let current='/';
   for(const part of dir.split('/').filter(Boolean)){current=path.join(current,part);
    const entry=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e});if(!entry)return;
    if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('unsafe');}
   await fs.rm(dir,{recursive:true,force:true});
  })().catch(()=>{process.stderr.write('remote_workspace_export_cleanup_failed');process.exitCode=1});`;
  await command(input.target, ["-e", script, input.remoteCwd, input.operationId], undefined, 10_000);
}

export async function captureRemoteWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string;
}) {
  const staged = await installArchiveHelper(input.target, input.remoteCwd, input.operationId);
  // Publish the archive and receipt as one immutable directory. Concurrent
  // invocations own separate attempts; no invocation unlinks another's archive.
  const capture = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');const {promisify}=require('node:util');(async()=>{
   const [helper,root,directory]=process.argv.slice(1),canonical=path.join(directory,'captured');
   const readPair=async(dir,layout,required)=>{
    const st=await fs.lstat(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e});if(!st)return null;
    if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(dir)!==dir)throw Error('unsafe_capture');
    const receipt=path.join(dir,'receipt.json'),archive=path.join(dir,'workspace.pcws');
    const receiptStat=await fs.lstat(receipt).catch(e=>{if(!required&&e.code==='ENOENT')return null;throw e});if(!receiptStat)return null;
    const archiveStat=await fs.lstat(archive);
    if(!receiptStat.isFile()||receiptStat.isSymbolicLink()||receiptStat.nlink!==1||receiptStat.size>16384
     ||!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.nlink!==1)throw Error('unsafe_capture');
    const result=JSON.parse(await fs.readFile(receipt,'utf8'));if(archiveStat.size!==result.byteSize)throw Error('invalid_capture');
    return {...result,layout};
   };
   let result=await readPair(canonical,'captured',true)??await readPair(directory,'legacy',false),attempt;
   try{if(!result){
    attempt=await fs.mkdtemp(path.join(directory,'capture-'));
    const archive=path.join(attempt,'workspace.pcws'),receipt=path.join(attempt,'receipt.json');
    const captured=await promisify(cp.execFile)(process.execPath,[helper,'capture',root,archive],{maxBuffer:1048576});
    await fs.writeFile(receipt,JSON.stringify(JSON.parse(captured.stdout)),{mode:0o600,flag:'wx'});
    await readPair(attempt,'captured',true);
    try{await fs.rename(attempt,canonical);attempt=undefined}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;}
    result=await readPair(canonical,'captured',true);if(!result)throw Error('capture_missing');
   }process.stdout.write(JSON.stringify(result));}finally{if(attempt)await fs.rm(attempt,{recursive:true,force:true});}
  })().catch(error=>{
   const gitOperation='remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace';
   process.stderr.write(typeof error?.stderr==='string'&&error.stderr.trim()===gitOperation?gitOperation:'remote_workspace_capture_failed');process.exitCode=1;
  });`;
  const { layout, ...receipt } = JSON.parse(await command(input.target, ["-e", capture, staged.helper, input.remoteCwd, staged.directory])) as {
    manifestDigest: string; sha256: string; byteSize: number; entries: number; layout: "legacy" | "captured";
  };
  if (!["legacy", "captured"].includes(layout) || !/^[a-f0-9]{64}$/.test(receipt.manifestDigest) || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) throw new Error("remote_workspace_capture_receipt_invalid");
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-upload-"));
  const archivePath = path.join(root, "workspace.pcws");
  try {
    await input.target.runner!.syncOut!([{ operationId: input.operationId,
      files: [{ kind: "file", sourcePath: layout === "captured" ? path.posix.join(staged.directory, "captured", "workspace.pcws") : staged.archive, targetPath: archivePath }],
    }]);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(archivePath)) { hash.update(chunk); bytes += chunk.length; }
    if (hash.digest("hex") !== receipt.sha256 || bytes !== receipt.byteSize) throw new Error("remote_workspace_capture_transfer_mismatch");
    return { ...receipt, archivePath, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function restoreRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; archivePath: string; manifestDigest: string; restorationIdentity: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.restorationIdentity)) throw new Error("remote_workspace_restore_identity_invalid");
  const id = input.restorationIdentity;
  const operationId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
  // Stage outside the destination; the restore validator requires an empty target.
  const parent = path.posix.dirname(input.remoteCwd);
  const staged = await installArchiveHelper(input.target, parent, operationId);
  await input.target.runner!.syncIn!([{ operationId,
    files: [{ kind: "file", sourcePath: input.archivePath, targetPath: staged.archive }],
  }]);
  // Publish the restored folder and its identity together. A lost successful
  // reply can then adopt the same files without repeating a destructive restore.
  const restore = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
  (async()=>{const [helper,archive,root,digest,identity]=process.argv.slice(1);
   if(!/^[a-f0-9]{64}$/.test(identity))throw Error('invalid_identity');
   const prior=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
   if(prior){
    if(!prior.isDirectory()||prior.isSymbolicLink()||await fs.realpath(root)!==root)throw Error('unsafe_root');
    const runtime=path.join(root,'.paperclip-runtime'),marker=path.join(runtime,'workspace-restored.json');
    const dir=await fs.lstat(runtime);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('unsafe_receipt');
    const file=await fs.lstat(marker);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>16384)throw Error('unsafe_receipt');
    const receipt=JSON.parse(await fs.readFile(marker,'utf8'));
    if(receipt.identity!==identity||receipt.manifestDigest!==digest)throw Error('workspace_owner_changed');return;
   }
   const staged=await fs.mkdtemp(root+'.restoring-');
   await require('node:util').promisify(cp.execFile)(process.execPath,[helper,'restore',archive,staged,digest],{maxBuffer:1048576});
   const runtime=path.join(staged,'.paperclip-runtime');await fs.mkdir(runtime,{mode:0o700});
   await fs.writeFile(path.join(runtime,'workspace-restored.json'),JSON.stringify({identity,manifestDigest:digest}),{flag:'wx',mode:0o600});
   if(await fs.realpath(path.dirname(root))!==path.dirname(root))throw Error('unsafe_root');await fs.rename(staged,root);
  })().catch(()=>{process.stderr.write('remote_workspace_restore_failed');process.exitCode=1});`;
  await command(input.target, ["-e", restore, staged.helper, staged.archive, input.remoteCwd, input.manifestDigest, input.restorationIdentity]);
  // Publish the restored location before cleanup can fail, stall, or lose its
  // reply. The owner journals this receipt and then reclaims disposable staging.
  return { operationId, stagingRoot: parent, cleanupPending: true };
}
