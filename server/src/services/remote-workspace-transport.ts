import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { RemoteWorkspaceSource } from "@paperclipai/shared";
import { captureRemoteWorkspaceDirectory, remoteWorkspaceArchiveScript, remoteWorkspaceCaptureFailureMessage, remoteWorkspaceFailureDetail } from "./remote-workspace-snapshot-archive.js";
import { readWorkspaceInventory, readonlyWorkspaceInventoryScript } from "./remote-workspace-readonly-inventory.js";
import { removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { classifyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { MAX_SANDBOX_SYNC_TIMEOUT_MS, type SandboxSyncOperation } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

export type RemoteWorkspaceTarget = Extract<AdapterExecutionTarget, { transport: "sandbox" }>;

async function transferArchive(target: RemoteWorkspaceTarget, direction: "syncIn" | "syncOut",
  operations: SandboxSyncOperation[], byteSize: number) {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("remote_workspace_archive_size_invalid");
  const timeoutMs = Math.min(MAX_SANDBOX_SYNC_TIMEOUT_MS, 60_000 + Math.ceil(byteSize / 1024 ** 2) * 1_000);
  return timeoutMs > 300_000
    ? target.runner![direction]!(operations, { minimumTimeoutMs: timeoutMs })
    : target.runner![direction]!(operations);
}

const checkoutConfiguredRefScript = String.raw`if(input.ref){const remoteRef=input.ref.replace(/^refs\/heads\//,'');
 const selected=await git(['rev-parse','--verify','--end-of-options',input.ref+'^{commit}'])
   .catch(()=>git(['rev-parse','--verify','--end-of-options','refs/remotes/origin/'+remoteRef+'^{commit}']));
 await git(['checkout','--detach',selected.stdout.trim()]);}`;

export function requireRemoteWorkspaceTarget(target: AdapterExecutionTarget | null): RemoteWorkspaceTarget {
  if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner || target.runnerTask
    || !target.runner.syncIn || !target.runner.syncOut) throw new Error("remote_workspace_transport_unsupported");
  return target;
}

/** The workspace archive is built inside the sandbox, so a full sandbox disk stops the save. */
export const REMOTE_WORKSPACE_SANDBOX_DISK_FULL =
  "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace";
// Node reports ENOSPC or EDQUOT. Git and tar child processes report the text.
const DISK_FULL_CHECK = String.raw`const diskFull=e=>['ENOSPC','EDQUOT'].includes(e?.code)||/No space left on device|Disk quota exceeded/i.test(String(e?.stderr??'')+String(e?.message??''));`;
const CAPTURE_FAILURE_CHECK = `const captureFailure=${remoteWorkspaceCaptureFailureMessage.toString()};const failureDetail=${remoteWorkspaceFailureDetail.toString()};`;
// The only sandbox text a capture failure may add: a fixed stage plus bounded
// structured fields from remoteWorkspaceFailureDetail. Anything else is dropped.
const SANDBOX_CAPTURE_CAUSE = /^remote_workspace_capture_failed: stage=(?:helper|archive|publish)(?: (?:helper_)?(?:code|exit|signal|syscall|killed|program|name|reason)=[A-Za-z0-9_]{1,64}){0,16}$/;
// Setup scripts name the step they were in plus closed, structured fields. A
// reason is only a script's own snake_case refusal code; Git output selects a
// fixed label and is never copied. The server drops anything outside this grammar.
const SETUP_FAILURE_CHECK = String.raw`const setupFailure=(prefix,stage,error)=>{const fields=['stage='+stage];
 const message=typeof error?.message==='string'?error.message:'',stderr=typeof error?.stderr==='string'?error.stderr.trim():'';
 if(/^[a-z][a-z_]{2,47}$/.test(message))fields.push('reason='+message);
 const archive=/^remote_workspace_archive_([a-z_]{1,48})$/.exec(stderr)?.[1];if(archive)fields.push('archive='+archive);
 const errno=/^(E[A-Z0-9]{1,20}):/.exec(stderr)?.[1];if(errno)fields.push('code='+errno);
 if(diskFull(error))fields.push('disk=full');
 if(typeof error?.cmd==='string'&&error.cmd.startsWith('git ')){
  const git=[[/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|returned error: 40[13]/i,'auth_failed'],
   [/Repository not found|does not appear to be a git repository|returned error: 404/i,'repository_not_found'],
   [/Could not resolve host|Connection (?:timed out|refused|reset)|Failed to connect|unable to access/i,'network'],
   [/unknown revision|not a valid ref|Needed a single revision|invalid reference|did not match any|couldn't find remote ref/i,'ref_not_found']]
   .find(([pattern])=>pattern.test(stderr))?.[1];if(git)fields.push('git='+git);}
 for(const field of failureDetail(error).split(' ').filter(Boolean))if(!fields.some(value=>value.startsWith(field.split('=')[0]+'=')))fields.push(field);
 return prefix+': '+fields.join(' ');};`;
const SANDBOX_SETUP_CAUSE = /^remote_workspace_(prepare|repository|restore)_failed: stage=[a-z_]{1,32}(?: (?:reason|archive|disk|git|code|exit|signal|syscall|killed|program|name)=[A-Za-z0-9_]{1,64}){0,16}$/;

type RemoteWorkspaceOperation = "prepare" | "repository" | "archive_helper" | "capture" | "download" | "upload" | "restore" | "cleanup" | "recovery_attachment";

export class RemoteWorkspaceOperationTimeoutError extends Error {
  constructor(readonly operation: RemoteWorkspaceOperation, readonly timeoutMs: number) {
    super(`remote_workspace_operation_timed_out: ${operation} (configured timeout ${timeoutMs}ms)`);
    this.name = "RemoteWorkspaceOperationTimeoutError";
  }
}

/**
 * A failed remote workspace command. Its message names only server-validated
 * fields and an optional sandbox cause in a fixed grammar; never command output.
 */
export class RemoteWorkspaceOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkspaceOperationError";
  }
}

/**
 * The server-built diagnostic for a remote workspace failure, or null when the
 * error text is not one of these redacted forms and must stay off the record.
 */
export function remoteWorkspaceFailureCause(error: unknown): string | null {
  if (error instanceof RemoteWorkspaceOperationError || error instanceof RemoteWorkspaceOperationTimeoutError
    || error instanceof RemoteWorkspaceRestoreError) return error.message;
  if (!(error instanceof Error)) return null;
  if (remoteWorkspaceCaptureFailureMessage({ message: error.message }) === error.message) return error.message;
  const operation = providerRefusals.get(error);
  return operation ? remoteWorkspaceProviderRefusalCause(operation, error) : null;
}

export const REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE = "remote_workspace_prepare_timeout";

export class RemoteWorkspacePreparationTimeoutError extends RemoteWorkspaceOperationTimeoutError {
  readonly code = REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE;

  constructor(error: RemoteWorkspaceOperationTimeoutError) {
    super("prepare", error.timeoutMs);
    this.name = "RemoteWorkspacePreparationTimeoutError";
    this.cause = error;
  }
}

export const REMOTE_WORKSPACE_RESTORE_FAILED_CODE = "remote_workspace_restore_failed";

/** Where restoring a saved workspace into a new allocation stopped. */
export type RemoteWorkspaceRestoreStep = "snapshot_lookup" | "snapshot_download" | "sandbox_restore";

/**
 * A saved workspace that could not be restored before the agent started. The
 * saved version is never changed by a failed restore. The message names the
 * step and a redacted cause; provider or command text is never copied.
 * `retryable` is set only when the owner re-read the same writer, epoch, and
 * saved version with no unsaved work, so a bounded retry cannot overwrite work.
 */
export class RemoteWorkspaceRestoreError extends Error {
  readonly code = REMOTE_WORKSPACE_RESTORE_FAILED_CODE;

  constructor(readonly step: RemoteWorkspaceRestoreStep, readonly retryable: boolean, cause: unknown) {
    super(`${REMOTE_WORKSPACE_RESTORE_FAILED_CODE}: step=${step}; ${remoteWorkspaceRestoreFailureDetail(step, cause)}`);
    this.name = "RemoteWorkspaceRestoreError";
    this.cause = cause;
  }
}

function remoteWorkspaceRestoreFailureDetail(step: RemoteWorkspaceRestoreStep, cause: unknown) {
  const known = remoteWorkspaceFailureCause(cause);
  if (known) return known;
  // Server-side restore refusals are fixed snake_case codes.
  if (cause instanceof Error && /^remote_workspace_[a-z_]{3,64}$/.test(cause.message)) return cause.message;
  const { label, code, status } = sandboxProviderFailureLabel(cause);
  return `${step === "snapshot_download" ? "storage" : "transport"}=${label}${code ? ` code=${code}` : ""}${status ? ` status=${status}` : ""}`;
}

/** The restore failure carried by a setup error, through at most four causes. */
export function findRemoteWorkspaceRestoreError(error: unknown): RemoteWorkspaceRestoreError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof RemoteWorkspaceRestoreError) return cause;
  }
  return null;
}

const TRANSPORT_FAILURE_LABELS: Array<[RegExp, string]> = [
  [/daytona_sandbox_not_found/i, "daytona_sandbox_not_found"],
  [/sandbox lease \S+ is no longer active/i, "sandbox_lease_inactive"],
  [/\b(?:EACCES|EPERM|permission denied)\b/i, "permission_denied"],
  [/\b(?:not (?:started|running)|is stopped|state[^A-Za-z]{1,4}stopped|stopped sandbox)\b/i, "sandbox_not_running"],
  [/\b(?:timed? ?out|timeout|ETIMEDOUT)\b/i, "transport_timeout"],
  [/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|channel lost|transport_closed|websocket)\b/i, "transport_closed"],
  [/\b(?:401|403|unauthori[sz]ed|forbidden)\b/i, "provider_access_denied"],
  [/\b(?:429|rate.?limit(?:ed)?)\b/i, "provider_rate_limited"],
  [/\b(?:5\d\d|service unavailable|bad gateway|internal server error)\b/i, "provider_unavailable"],
];

// Copy-back errors the provider threw before any exit status, by operation.
// The error itself is rethrown unchanged, so existing callers and classifiers
// keep their contracts; only the recorded cause is derived from this.
const providerRefusals = new WeakMap<object, RemoteWorkspaceOperation>();
function noteProviderRefusal(operation: RemoteWorkspaceOperation, error: unknown) {
  if (error && typeof error === "object" && !providerRefusals.has(error)) providerRefusals.set(error, operation);
}

/**
 * A copy-back command that never produced an exit status (the provider or its
 * transport threw) is named by a closed label and an optional errno-style code.
 * Provider text can carry sandbox paths or identifiers, so it is never copied.
 */
function remoteWorkspaceProviderRefusalCause(operation: RemoteWorkspaceOperation, error: unknown): string | null {
  // Archive-safety and Git-metadata refusals have their own exact diagnostics.
  if (["restore_unsafe_archive", "restore_invalid_metadata"].includes(classifyWorkspaceRestoreFailure(error))) return null;
  const { label, code } = sandboxProviderFailureLabel(error);
  return `remote_workspace_operation_failed: operation=${operation} transport=${label}${code ? ` code=${code}` : ""}`;
}

/**
 * Name a sandbox provider failure by a closed label, an errno-style code, and
 * an HTTP-style status. Provider text can carry sandbox paths or identifiers,
 * so it only selects the label and is never copied into the result.
 */
export function sandboxProviderFailureLabel(error: unknown): { label: string; code: string | null; status: number | null } {
  const texts: string[] = [];
  let code: string | null = null;
  let status: number | null = null;
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof Error) texts.push(cause.message);
    else if (typeof cause === "string") texts.push(cause);
    const candidate = (cause as { code?: unknown }).code;
    if (!code && typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(candidate)) code = candidate;
    for (const key of ["status", "statusCode"] as const) {
      const value = (cause as Record<string, unknown>)[key];
      if (status === null && Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599) status = value as number;
    }
  }
  const text = texts.join("\n");
  const label = TRANSPORT_FAILURE_LABELS.find(([pattern]) => pattern.test(text) || (code !== null && pattern.test(code)))?.[1]
    ?? "provider_error";
  return { label, code, status };
}

const WORKSPACE_COMMAND_TIMEOUT_MS = 300_000;

async function command(target: RemoteWorkspaceTarget, operation: RemoteWorkspaceOperation,
  args: string[], env?: Record<string, string>, timeoutMs = WORKSPACE_COMMAND_TIMEOUT_MS) {
  const execute = () => target.runner!.execute({ command: "node", args, cwd: target.remoteCwd,
    env: { NODE_OPTIONS: "", NODE_PATH: "", ...env }, timeoutMs, bypassSession: true });
  // Copy-back and restore record why the provider refused the command.
  const result = operation === "capture" || operation === "archive_helper" || operation === "restore"
    ? await execute().catch((error: unknown) => { noteProviderRefusal(operation, error); throw error; })
    : await execute();
  if (result.timedOut) throw new RemoteWorkspaceOperationTimeoutError(operation, timeoutMs);
  if (result.exitCode !== 0) {
    const gitOperation = "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace";
    // One-shot providers can return combined output in stdout. Keep the same
    // exact safe diagnostics; never forward arbitrary output from either stream.
    const output = [result.stderr.trim(), result.stdout.trim()];
    const reported = output.find(value => [gitOperation, REMOTE_WORKSPACE_SANDBOX_DISK_FULL].includes(value))
      ?? (operation === "capture" || operation === "archive_helper"
        ? output.find(value => remoteWorkspaceCaptureFailureMessage({ message: value }) === value) : undefined);
    if (reported) throw new Error(reported);
    const cause = operation === "capture" || operation === "archive_helper"
      ? output.find(value => value.length <= 1024 && SANDBOX_CAPTURE_CAUSE.test(value))
      : output.find(value => value.length <= 1024 && SANDBOX_SETUP_CAUSE.exec(value)?.[1] === operation);
    const status = [`operation=${operation}`,
      Number.isSafeInteger(result.exitCode) ? `exit=${result.exitCode}` : null,
      typeof result.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(result.signal) ? `signal=${result.signal}` : null,
    ].filter(Boolean).join(" ");
    throw new RemoteWorkspaceOperationError(`remote_workspace_operation_failed: ${status}${cause ? `; ${cause}` : ""}`);
  }
  return result.stdout;
}

const RECOVERY_ATTACHMENT = String.raw`
const fs=require('node:fs/promises'),path=require('node:path');
(async()=>{
 const [root,raw]=process.argv.slice(1),input=JSON.parse(raw);
 if(!path.isAbsolute(root)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId)
  ||typeof input.provenance!=='string'||Buffer.byteLength(input.provenance)>16384)throw Error('invalid_attachment');
 const inspect=async p=>{try{return await fs.lstat(p)}catch(e){if(e.code==='ENOENT')return null;throw e}};
 const safeDirectory=async p=>{const s=await inspect(p);if(!s)return false;
  if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_attachment');return true};
 if(!await safeDirectory(root))throw Error('missing_workspace');
 const parent=path.join(root,'.paperclip-recovered'),destination=path.join(parent,input.operationId);
 if(!await safeDirectory(parent)||!await safeDirectory(destination)){process.stdout.write('missing');return}
 const proof=path.join(destination,'provenance.json'),s=await inspect(proof);
 if(!s?.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384||await fs.readFile(proof,'utf8')!==input.provenance)
  throw Error('attachment_proof_changed');
 process.stdout.write('present');
})().catch(()=>{process.stderr.write('remote_workspace_recovery_attachment_invalid');process.exitCode=1});`;

/** Reuse a restored attachment only with its exact provenance. User edits to
 * its files remain intact; unknown destinations are never overwritten. */
export async function hasRemoteRecoveryAttachment(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string; provenance: string;
}) {
  const output = await command(input.target, "recovery_attachment", ["-e", RECOVERY_ATTACHMENT,
    input.remoteCwd, JSON.stringify({ operationId: input.operationId, provenance: input.provenance })], undefined, 30_000);
  if (output !== "present" && output !== "missing") throw new Error("remote_workspace_recovery_attachment_invalid");
  return output === "present";
}

const PREPARE = String.raw`
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process');
const {promisify}=require('node:util'); const exec=promisify(cp.execFile);
${DISK_FULL_CHECK}${CAPTURE_FAILURE_CHECK}${SETUP_FAILURE_CHECK}let stage='validate';
(async()=>{
 const [root,raw]=process.argv.slice(1), input=JSON.parse(raw);
 if (!path.isAbsolute(root)||!/^[a-f0-9]{64}$/.test(input.preparationIdentity)) throw Error('invalid_root');
 const noConfig={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_CONFIG_PARAMETERS:'',GIT_TEMPLATE_DIR:'',GIT_ASKPASS:'',SSH_ASKPASS:''};
 const isolated={...process.env,...noConfig};for(const key of Object.keys(isolated))if(/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))delete isolated[key];
 const cloneEnv={...isolated};for(const key of input.authEnvKeys)if(/^GIT_CONFIG_(COUNT|(KEY|VALUE)_\d+)$/.test(key)&&process.env[key]!==undefined)cloneEnv[key]=process.env[key];
 const localEnv={...isolated};for(const key of input.authEnvKeys)delete localEnv[key];Object.assign(localEnv,noConfig);
 stage='create_parent';let current='/'; for(const part of path.dirname(root).split('/').filter(Boolean)) {
  current=path.join(current,part); await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
  const s=await fs.lstat(current); if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_root');
 }
 stage='inspect_existing';const prior=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
 if(prior){
  if(!prior.isDirectory()||prior.isSymbolicLink()||await fs.realpath(root)!==root)throw Error('unsafe_root');
  const runtime=path.join(root,'.paperclip-runtime'),marker=path.join(runtime,'workspace-ready.json');
  const dir=await fs.lstat(runtime);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('unsafe_receipt');
  const file=await fs.lstat(marker);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>16384)throw Error('unsafe_receipt');
  if(JSON.parse(await fs.readFile(marker,'utf8')).preparationIdentity!==input.preparationIdentity)throw Error('workspace_owner_changed');
  process.stdout.write(JSON.stringify({cwd:root}));return;
 }
 if(input.probeOnly){process.stdout.write(JSON.stringify({cloneRequired:true}));return;}
 stage='stage';const staged=await fs.mkdtemp(root+'.preparing-');
 if(input.kind==='git'){
  stage='clone';await exec('git',['-c','core.hooksPath=/dev/null','-c','init.templateDir=',...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,staged],{env:cloneEnv});
  const git=async args=>exec('git',['-c','core.hooksPath=/dev/null','-C',staged,...args],{env:localEnv});
  if(input.branchMode==='existing'){
   stage='checkout_branch';if(!input.branchName)throw Error('existing_branch_required');
   await git(['check-ref-format','--branch',input.branchName]);
   const remoteRef='refs/remotes/origin/'+input.branchName;
   await git(['rev-parse','--verify','--quiet',remoteRef+'^{commit}']);
   const local=await git(['show-ref','--verify','--quiet','refs/heads/'+input.branchName]).then(()=>true,()=>false);
   await git(local?['checkout',input.branchName]:['checkout','-b',input.branchName,remoteRef]);
  }else{
   stage='checkout_ref';
   ${checkoutConfiguredRefScript}
   if(input.branchName)await git(['checkout','-B',input.branchName]);
  }
  stage='configure';await fs.mkdir(path.join(staged,'.git','info'),{recursive:true,mode:0o700});
  await fs.appendFile(path.join(staged,'.git','info','exclude'),'\n/.paperclip-runtime/\n/.paperclip-repositories/\n');
 }else{
  stage='configure';await fs.writeFile(path.join(staged,'.gitignore'),'/.paperclip-runtime/\n/.paperclip-repositories/\n',{flag:'wx',mode:0o600});
 }
 stage='write_receipt';const runtime=path.join(staged,'.paperclip-runtime');await fs.mkdir(runtime,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
 const runtimeStat=await fs.lstat(runtime);if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink())throw Error('unsafe_receipt');
 await fs.writeFile(path.join(runtime,'workspace-ready.json'),JSON.stringify({preparationIdentity:input.preparationIdentity}),{flag:'wx',mode:0o600});
 stage='publish';if(await fs.realpath(path.dirname(root))!==path.dirname(root))throw Error('unsafe_root');
 await fs.rename(staged,root);
 process.stdout.write(JSON.stringify({cwd:await fs.realpath(root)}));
})().catch(error=>{process.stderr.write(setupFailure('remote_workspace_prepare_failed',stage,error));process.exitCode=1});`;

export async function prepareRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; source: RemoteWorkspaceSource; resolveGitAuth: GitRemoteAuthProvider;
  preparationIdentity: string;
}) {
  if (input.source.kind === "git") {
    const prior = JSON.parse(await command(input.target, "prepare", ["-e", PREPARE, input.remoteCwd,
      JSON.stringify({ ...input.source, preparationIdentity: input.preparationIdentity,
        authArgs: [], authEnvKeys: [], probeOnly: true })])) as { cwd?: string; cloneRequired?: boolean };
    if (prior.cwd === input.remoteCwd) return;
    if (prior.cloneRequired !== true) throw new Error("remote_workspace_root_changed");
  }
  const auth = input.source.kind === "git" ? await input.resolveGitAuth(input.source.repoUrl) : null;
  const output = await command(input.target, "prepare", ["-e", PREPARE, input.remoteCwd,
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
  ${DISK_FULL_CHECK}${CAPTURE_FAILURE_CHECK}${SETUP_FAILURE_CHECK}let stage='validate';
  (async()=>{const [root,raw]=process.argv.slice(1),input=JSON.parse(raw);const noConfig={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_CONFIG_PARAMETERS:'',GIT_TEMPLATE_DIR:'',GIT_ASKPASS:'',SSH_ASKPASS:''};
  const env={...process.env,...noConfig};for(const key of Object.keys(env))if(/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))delete env[key];
  const cloneEnv={...env};for(const key of input.authEnvKeys)if(/^GIT_CONFIG_(COUNT|(KEY|VALUE)_\d+)$/.test(key)&&process.env[key]!==undefined)cloneEnv[key]=process.env[key];
  const localEnv={...env};for(const key of input.authEnvKeys)delete localEnv[key];Object.assign(localEnv,noConfig);const opts={env:localEnv};
  stage='create_parent';let parent='/';for(const part of path.dirname(root).split('/').filter(Boolean)){parent=path.join(parent,part);
   await fs.mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const entry=await fs.lstat(parent);
   if(!entry.isDirectory()||entry.isSymbolicLink()||await fs.realpath(parent)!==parent)throw Error('unsafe_repository_parent');}
  stage='inspect';const existing=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(existing){if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('unsafe_repository')}
  else{if(input.verifyOnly||input.savedArchive)throw Error('repository_missing');if(input.probeOnly){process.stdout.write(JSON.stringify({cloneRequired:true}));return;}
   stage='stage';const staged=await fs.mkdtemp(root+'.preparing-');try{
    stage='clone';await exec('git',['-c','core.hooksPath=/dev/null','-c','init.templateDir=',...input.authArgs,'clone','--no-hardlinks','--',input.repoUrl,staged],{env:cloneEnv});
    const git=async args=>exec('git',['-c','core.hooksPath=/dev/null','-C',staged,...args],opts);
    stage='checkout_ref';
    ${checkoutConfiguredRefScript}
    stage='publish';await fs.rename(staged,root);
   }finally{await fs.rm(staged,{recursive:true,force:true});}}
  const git=async args=>(await exec('git',['-c','core.hooksPath=/dev/null','-C',root,...args],opts)).stdout.trim();
  stage='verify_origin';if(await fs.realpath(root)!==root)throw Error('unsafe_repository');
  const hasOrigin=(await git(['remote'])).split('\n').includes('origin');
  const origin=hasOrigin?await git(['remote','get-url','origin']):null;
  if(origin!==input.repoUrl&&!(input.savedArchive&&origin===null))throw Error('repository_origin_changed');
  stage='verify_commit';const head=await git(['rev-parse','HEAD']);if(input.pinnedCommit)await git(['cat-file','-e',input.pinnedCommit+'^{commit}']);
  const branch=await git(['symbolic-ref','--short','-q','HEAD']).catch(()=>null);process.stdout.write(JSON.stringify({cwd:root,pinnedCommit:input.pinnedCommit||head,branchName:branch}));
  })().catch(error=>{process.stderr.write(setupFailure('remote_workspace_repository_failed',stage,error));process.exitCode=1});`;
  const payload = { ...input, target: undefined, resolveGitAuth: undefined };
  const prior = JSON.parse(await command(input.target, "repository", ["-e", script, input.remoteCwd,
    JSON.stringify({ ...payload, authArgs: [], authEnvKeys: [], probeOnly: true })])) as {
      cwd?: string; pinnedCommit?: string; branchName?: string | null; cloneRequired?: boolean;
    };
  if (prior.cloneRequired !== true) {
    if (prior.cwd !== input.remoteCwd || !/^[a-f0-9]{40,64}$/.test(prior.pinnedCommit ?? "")) throw new Error("remote_workspace_repository_receipt_invalid");
    return { cwd: prior.cwd, pinnedCommit: prior.pinnedCommit!, branchName: prior.branchName ?? null };
  }
  const auth = await input.resolveGitAuth(input.repoUrl);
  const output = await command(input.target, "repository", ["-e", script, input.remoteCwd,
    JSON.stringify({ ...payload, authArgs: auth?.configArgs ?? [], authEnvKeys: Object.keys(auth?.env ?? {}) })], auth?.env);
  const value = JSON.parse(output) as { cwd: string; pinnedCommit: string; branchName: string | null };
  if (value.cwd !== input.remoteCwd || !/^[a-f0-9]{40,64}$/.test(value.pinnedCommit)) throw new Error("remote_workspace_repository_receipt_invalid");
  return value;
}

async function installArchiveHelper(target: RemoteWorkspaceTarget, remoteCwd: string, operationId: string) {
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("remote_workspace_operation_identity_invalid");
  const directory = path.posix.join(remoteCwd, ".paperclip-runtime", "workspace-snapshots", operationId);
  const helper = path.posix.join(directory, "archive.cjs");
  const install = String.raw`const fs=require('node:fs/promises'),path=require('node:path');${DISK_FULL_CHECK}${CAPTURE_FAILURE_CHECK}(async()=>{
   const [root,dir,file,body]=process.argv.slice(1);let p='/';
   for(const s of root.split('/').filter(Boolean)){p=path.join(p,s);await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe');}
   for(const s of path.relative(root,dir).split('/')){p=path.join(p,s);await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe');}
   const existing=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e});if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw Error('unsafe');
   const temp=file+'.'+require('node:crypto').randomUUID()+'.tmp';
   // A failed write can leave partial bytes. Remove only the temporary file this run created.
   try{await fs.writeFile(temp,Buffer.from(body,'base64'),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}
   catch(e){if(e?.code!=='EEXIST')await fs.rm(temp,{force:true}).catch(()=>{});throw e;}
  })().catch(error=>{const detail=failureDetail(error),message=diskFull(error)?${JSON.stringify(REMOTE_WORKSPACE_SANDBOX_DISK_FULL)}
   :captureFailure(error)??'remote_workspace_capture_failed: stage=helper'+(detail?' '+detail:'');process.stderr.write(message);process.exitCode=1});`;
  await command(target, "archive_helper", ["-e", install, remoteCwd, directory, helper, Buffer.from(remoteWorkspaceArchiveScript()).toString("base64")]);
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
  await command(input.target, "cleanup", ["-e", script, input.remoteCwd, input.operationId], undefined, 10_000);
}

/**
 * Wall-clock milliseconds for each save phase, filled in as each phase ends so a
 * failed save still reports the phases it finished. It holds only durations and
 * archive counts, never paths or provider text.
 */
export type RemoteWorkspaceSavePhaseTiming = {
  /** Archive helper install plus in-sandbox capture. */
  captureMs?: number;
  /** Provider download of the captured archive. */
  transferMs?: number;
  /** Server-side re-hash of the downloaded archive. */
  verifyMs?: number;
  byteSize?: number;
  entries?: number;
};

const elapsedSince = (started: number) => Math.max(0, Math.round(performance.now() - started));

export async function captureRemoteWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string; timing?: RemoteWorkspaceSavePhaseTiming;
}) {
  try { return await captureSandboxWorkspaceArchive(input); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== REMOTE_WORKSPACE_SANDBOX_DISK_FULL) throw error;
    // Disk exhaustion cannot be repaired by writing another archive to the
    // same sandbox. Transfer a verified standalone source without writing to
    // it, then normalize and seal it on the controller. Failed verification
    // retains the original disk-full failure and never permits source cleanup.
    try { return await captureReadOnlyWorkspaceArchive(input); }
    catch (cause) { throw new Error(error.message, { cause }); }
  }
}

async function captureReadOnlyWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string;
}) {
  if (!/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("remote_workspace_operation_identity_invalid");
  const inspect = async (timeoutMs = WORKSPACE_COMMAND_TIMEOUT_MS) => {
    const value = JSON.parse(await command(input.target, "capture", ["-e", readonlyWorkspaceInventoryScript(), input.remoteCwd], undefined, timeoutMs)) as Awaited<ReturnType<typeof readWorkspaceInventory>>;
    if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0
      || !Number.isSafeInteger(value.entries) || value.entries < 0 || !Array.isArray(value.exclude)
      || value.exclude.length > 4096 || !value.exclude.every(item => typeof item === "string" && item.length > 0
        && !/[\\\u0000-\u001f\u007f]/u.test(item) && !path.posix.isAbsolute(item)
        && item.split("/").every(part => part !== "" && part !== "." && part !== ".."))
      || !value.exclude.includes(".paperclip-runtime")) throw new Error("remote_workspace_readonly_capture_unsafe");
    return value;
  };
  let root: string | undefined;
  let stage: "inspect" | "transfer" | "verify" | "archive" = "inspect";
  try {
    const before = await inspect();
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-readonly-"));
    root = await realpath(root);
    const copy = path.join(root, "source"), archivePath = path.join(root, "workspace.pcws");
    stage = "transfer";
    await transferArchive(input.target, "syncOut", [{ operationId: input.operationId,
      files: [{ kind: "directory", sourcePath: input.remoteCwd, targetPath: copy,
        followSymlinks: false, preserveSourceEntries: true, exclude: before.exclude }] }], Math.max(1, before.byteSize));
    stage = "verify";
    const verificationStarted = performance.now();
    const verificationSignal = AbortSignal.timeout(120_000);
    const remaining = () => { verificationSignal.throwIfAborted(); return Math.max(1, Math.ceil(120_000 - (performance.now() - verificationStarted))); };
    const received = await readWorkspaceInventory(copy, true, verificationSignal);
    const same = (observed: typeof before) => observed.sha256 === before.sha256
      && observed.byteSize === before.byteSize && observed.entries === before.entries;
    if (!same(received) || !same(await inspect(remaining()))) throw new Error("remote_workspace_readonly_capture_changed");
    const finalVerificationBudget = remaining();
    stage = "archive";
    const captureSignal = AbortSignal.timeout(WORKSPACE_COMMAND_TIMEOUT_MS);
    const receipt = await captureRemoteWorkspaceDirectory({ cwd: copy, archivePath, exclude: before.exclude, signal: captureSignal });
    captureSignal.throwIfAborted();
    stage = "verify";
    const finalVerificationSignal = AbortSignal.timeout(finalVerificationBudget);
    if (!same(await inspect(finalVerificationBudget))) throw new Error("remote_workspace_readonly_capture_changed");
    finalVerificationSignal.throwIfAborted();
    // Only the sealed portable archive remains a candidate for durable upload.
    await removeTaskDirectoryTree(copy);
    const savedRoot = root;
    return { ...receipt, archivePath, cleanup: () => removeTaskDirectoryTree(savedRoot) };
  } catch (error) {
    if (root) await removeTaskDirectoryTree(root);
    const reason = error instanceof Error && error.message === "remote_workspace_readonly_capture_unsafe" ? "unsafe_source"
      : error instanceof Error && error.message === "remote_workspace_readonly_capture_changed" ? "source_changed"
        : error instanceof Error && error.message === "remote_workspace_readonly_capture_budget" ? "budget_exceeded" : "operation_failed";
    const { label, code } = sandboxProviderFailureLabel(error);
    throw new Error(`remote_workspace_readonly_capture_failed: stage=${stage} reason=${reason} transport=${label}${code ? ` code=${code}` : ""}`);
  }
}

async function captureSandboxWorkspaceArchive(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; operationId: string; timing?: RemoteWorkspaceSavePhaseTiming;
}) {
  const timing = input.timing ?? {};
  const captureStarted = performance.now();
  const staged = await installArchiveHelper(input.target, input.remoteCwd, input.operationId);
  // Publish the archive and receipt as one immutable directory. Concurrent
  // invocations own separate attempts; no invocation unlinks another's archive.
  const capture = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');const {promisify}=require('node:util');${DISK_FULL_CHECK}${CAPTURE_FAILURE_CHECK}(async()=>{
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
   process.stderr.write(typeof error?.stderr==='string'&&error.stderr.trim()===gitOperation?gitOperation
    :diskFull(error)?${JSON.stringify(REMOTE_WORKSPACE_SANDBOX_DISK_FULL)}
    :captureFailure({message:typeof error?.stderr==='string'?error.stderr.trim():null})??captureFailure(error)??(()=>{
     // The archive child reports its own bounded detail; this process adds the child's exit.
     const helper=typeof error?.cmd==='string',own=failureDetail(error);
     const child=helper&&typeof error.stderr==='string'?/^remote_workspace_archive_failed: ([A-Za-z0-9_= ]{1,512})$/.exec(error.stderr.trim())?.[1]:undefined;
     return 'remote_workspace_capture_failed: stage='+(helper?'archive':'publish')+(child?' '+child:'')
      +(own?' '+(helper?own.split(' ').map(field=>'helper_'+field).join(' '):own):'');
    })());process.exitCode=1;
  });`;
  const { layout, ...receipt } = JSON.parse(await command(input.target, "capture", ["-e", capture, staged.helper, input.remoteCwd, staged.directory])) as {
    manifestDigest: string; sha256: string; byteSize: number; entries: number; layout: "legacy" | "captured";
  };
  if (!["legacy", "captured"].includes(layout) || !/^[a-f0-9]{64}$/.test(receipt.manifestDigest) || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) throw new Error("remote_workspace_capture_receipt_invalid");
  timing.captureMs = elapsedSince(captureStarted); timing.byteSize = receipt.byteSize;
  if (Number.isSafeInteger(receipt.entries) && receipt.entries >= 0) timing.entries = receipt.entries;
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-upload-"));
  const archivePath = path.join(root, "workspace.pcws");
  try {
    const transferStarted = performance.now();
    await transferArchive(input.target, "syncOut", [{ operationId: input.operationId,
      files: [{ kind: "file", sourcePath: layout === "captured" ? path.posix.join(staged.directory, "captured", "workspace.pcws") : staged.archive, targetPath: archivePath }],
    }], receipt.byteSize);
    timing.transferMs = elapsedSince(transferStarted);
    const verifyStarted = performance.now();
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(archivePath)) { hash.update(chunk); bytes += chunk.length; }
    timing.verifyMs = elapsedSince(verifyStarted);
    if (hash.digest("hex") !== receipt.sha256 || bytes !== receipt.byteSize) throw new Error("remote_workspace_capture_transfer_mismatch");
    return { ...receipt, archivePath, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (!(error instanceof Error && error.message === "remote_workspace_capture_transfer_mismatch")) noteProviderRefusal("download", error);
    throw error;
  }
}

export async function restoreRemoteWorkspaceDirectory(input: {
  target: RemoteWorkspaceTarget; remoteCwd: string; archivePath: string; manifestDigest: string; restorationIdentity: string; restorationEpoch?: number; allowEmptyRoot?: boolean;
  allocationFiles?: Array<{ relativePath: string; sha256: string }>;
  /** The server proved this sandbox's root is the workspace's own earlier allocation, fully saved. */
  replaceRetiredRoot?: boolean;
}) {
  if (input.replaceRetiredRoot && input.allowEmptyRoot) throw new Error("remote_workspace_restore_mode_invalid");
  if (input.restorationEpoch !== undefined && (!Number.isSafeInteger(input.restorationEpoch) || input.restorationEpoch < 1))
    throw new Error("remote_workspace_restore_epoch_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.restorationIdentity)) throw new Error("remote_workspace_restore_identity_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.manifestDigest)) throw new Error("remote_workspace_restore_manifest_invalid");
  const id = input.restorationIdentity;
  const operationId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
  // Stage outside the destination; the restore validator requires an empty target.
  const parent = path.posix.dirname(input.remoteCwd);
  const staged = await installArchiveHelper(input.target, parent, operationId);
  await stat(input.archivePath).then(archive => transferArchive(input.target, "syncIn", [{ operationId,
    files: [{ kind: "file", sourcePath: input.archivePath, targetPath: staged.archive }],
  }], archive.size)).catch((error: unknown) => { noteProviderRefusal("upload", error); throw error; });
  // Publish the restored folder and its identity together. A lost successful
  // reply can then adopt the same files without repeating a destructive restore.
  const restore = String.raw`const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
  ${DISK_FULL_CHECK}${CAPTURE_FAILURE_CHECK}${SETUP_FAILURE_CHECK}let stage='validate';
  (async()=>{const [helper,archive,root,digest,identity,allowEmpty,rawFiles,replaceRetired,rawEpoch]=process.argv.slice(1),files=JSON.parse(rawFiles);
   const validEpoch=value=>Number.isSafeInteger(value)&&value>0,restorationEpoch=rawEpoch===undefined||rawEpoch===''?null:Number(rawEpoch);
   if(restorationEpoch!==null&&!validEpoch(restorationEpoch))throw Error('invalid_epoch');
   const completedReceipt=(id,manifestDigest,epoch)=>epoch===null?{identity:id,manifestDigest}
    :{schema:'paperclip.workspace-restored.v1',root,restorationEpoch:epoch,identity:id,manifestDigest};
   if(!/^[a-f0-9]{64}$/.test(identity)||!/^[a-f0-9]{64}$/.test(digest)||!Array.isArray(files)||files.length>8)throw Error('invalid_identity');
   for(const file of files)if(!/^\.paperclip-runtime\/[a-zA-Z0-9_-]+\.json$/.test(file.relativePath)
     ||file.relativePath==='.paperclip-runtime/workspace-restored.json'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid_allocation');
   if(new Set(files.map(file=>file.relativePath)).size!==files.length)throw Error('invalid_allocation');
   const stat=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e});
   const directory=async p=>{const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_root')};
   const readJson=async(file,reason)=>{const body=await fs.readFile(file,'utf8');try{return JSON.parse(body)}catch{throw Error(reason)}};
   const allocation=async p=>{
    await directory(p);const names=await fs.readdir(p);
    if(names.length===0&&files.length===0)return [];
    if(names.length!==1||names[0]!=='.paperclip-runtime'||!files.length)throw Error('occupied_root');
    const runtime=path.join(p,'.paperclip-runtime');await directory(runtime);
    const contents=await fs.readdir(runtime),expected=files.map(file=>path.basename(file.relativePath));
    if(contents.length!==expected.length||contents.some(name=>!expected.includes(name)))throw Error('occupied_root');
    return Promise.all(files.map(async file=>{const name=path.join(p,file.relativePath),s=await fs.lstat(name);
     if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384)throw Error('unsafe_allocation');
     const content=await fs.readFile(name);if(crypto.createHash('sha256').update(content).digest('hex')!==file.sha256)throw Error('allocation_changed');
     return {name:path.basename(name),content};}));
   };
   // A retired root holds a Paperclip preparation or restore receipt; anything else is unknown.
   const ownReceipt=async p=>{
    const runtime=path.join(p,'.paperclip-runtime');if(!await stat(runtime))return false;await directory(runtime);
    for(const [name,key] of [['workspace-restored.json','identity'],['workspace-ready.json','preparationIdentity']]){
     const file=path.join(runtime,name),s=await stat(file);if(!s)continue;
     if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384)throw Error('unsafe_receipt');
     if(/^[a-f0-9]{64}$/.test(String((await readJson(file,'unsafe_receipt'))?.[key])))return true;}
    return false;
   };
   const parked=root+'.allocation-'+identity,retired=root+'.retired-'+identity;
   // Runtime state beside the files (for example a retained runner session) is
   // never saved; it belongs to this sandbox. Move it into the restored root
   // before removing the retired one. Its old receipts and export staging stay behind.
   // Only an authorized replace with this identity creates that path, so a repeat
   // of the same restore finishes an interrupted carry without a new proof.
   // Saved directory modes can be read-only. Make the parked tree's own directories
   // owner-writable without following symlinks, then remove it.
   const open=async d=>{const s=await fs.lstat(d);if(!s.isDirectory()||s.isSymbolicLink())return;
    await fs.chmod(d,(s.mode&0o7777)|0o700);for(const name of await fs.readdir(d))await open(path.join(d,name));};
   const removeRetired=async()=>{if(!await stat(retired))return;
    stage='carry_runtime';const from=path.join(retired,'.paperclip-runtime'),to=path.join(root,'.paperclip-runtime');
    if(await stat(from)){await directory(from);await directory(to);
     for(const name of await fs.readdir(from)){
      if(['workspace-ready.json','workspace-restored.json','workspace-snapshots'].includes(name)||await stat(path.join(to,name)))continue;
      await fs.rename(path.join(from,name),path.join(to,name));}}
    stage='cleanup_parked';await open(retired);await fs.rm(retired,{recursive:true,force:true});};
   const pendingInPlace=receipt=>receipt.schema==='paperclip.workspace-restore-pending.v1'&&receipt.root===root&&validEpoch(receipt.restorationEpoch)
    &&typeof receipt.pendingIdentity==='string'&&/^[a-f0-9]{64}$/.test(receipt.pendingIdentity)
    &&typeof receipt.manifestDigest==='string'&&/^[a-f0-9]{64}$/.test(receipt.manifestDigest)
    &&Number.isSafeInteger(receipt.inPlaceMode)&&receipt.inPlaceMode>=0&&receipt.inPlaceMode<=0o7777;
   const finishInPlace=async receipt=>{
    if(!pendingInPlace(receipt))throw Error('unsafe_receipt');
    stage='cleanup_replaced';await fs.rm(path.join(root,'.paperclip-runtime','workspace-ready.json'),{force:true});
    await fs.chmod(root,receipt.inPlaceMode);
    stage='commit_replaced';const marker=path.join(root,'.paperclip-runtime','workspace-restored.json'),pending=marker+'.'+crypto.randomUUID()+'.tmp';
    const completed=completedReceipt(receipt.pendingIdentity,receipt.manifestDigest,receipt.restorationEpoch);
    try{await fs.writeFile(pending,JSON.stringify(completed),{flag:'wx',mode:0o600});await fs.rename(pending,marker);return completed;}
    finally{await fs.rm(pending,{force:true});}
   };
   const replaceInPlace=async staged=>{stage='replace_in_place';const runtime=path.join(root,'.paperclip-runtime');
    const s=await fs.lstat(root);await fs.chmod(root,(s.mode&0o7777)|0o700);
    for(const name of await fs.readdir(root))if(name!=='.paperclip-runtime'){await open(path.join(root,name));await fs.rm(path.join(root,name),{recursive:true,force:true});}
    if(await stat(path.join(runtime,'workspace-snapshots'))){await open(path.join(runtime,'workspace-snapshots'));
     await fs.rm(path.join(runtime,'workspace-snapshots'),{recursive:true,force:true});}
    for(const name of await fs.readdir(staged))if(name!=='.paperclip-runtime')await fs.rename(path.join(staged,name),path.join(root,name));
    const receiptFile=path.join(staged,'.paperclip-runtime','workspace-restored.json'),receipt={schema:'paperclip.workspace-restore-pending.v1',
     root,pendingIdentity:identity,manifestDigest:digest,restorationEpoch,inPlaceMode:(await fs.lstat(staged)).mode&0o7777};
    await fs.writeFile(receiptFile,JSON.stringify(receipt),{mode:0o600});
    await fs.rename(path.join(staged,'.paperclip-runtime','workspace-restored.json'),path.join(runtime,'workspace-restored.json'));
    await finishInPlace(receipt);};
   stage='restore_lock';await directory(path.dirname(root));
   const lockRoot=path.join(path.dirname(root),'.paperclip-runtime','workspace-restore-locks');
   await directory(path.dirname(lockRoot));
   for(const parent of [path.dirname(root),path.dirname(lockRoot)]){const s=await fs.lstat(parent);
    if(s.uid!==process.getuid()||(s.mode&0o022)!==0)throw Error('unsafe_restore_lock');}
   await fs.mkdir(lockRoot,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});
   await directory(lockRoot);const lockDirectory=await fs.lstat(lockRoot);
   if(lockDirectory.uid!==process.getuid()||(lockDirectory.mode&0o077)!==0)throw Error('unsafe_restore_lock');
   const lockPath=path.join(lockRoot,crypto.createHash('sha256').update(root).digest('hex')+'.sqlite'),lockStat=await stat(lockPath);
   if(lockStat&&(!lockStat.isFile()||lockStat.isSymbolicLink()||lockStat.nlink!==1||lockStat.uid!==process.getuid()||lockStat.size>65536))throw Error('unsafe_restore_lock');
   const lock=new(require('node:sqlite').DatabaseSync)(lockPath,{allowExtension:false});
   try{
    await fs.chmod(lockPath,0o600);lock.exec('PRAGMA busy_timeout=0');const deadline=performance.now()+120000;
    while(true){try{lock.exec('BEGIN IMMEDIATE');break}catch(e){if(typeof e.errcode!=='number'||(e.errcode&255)!==5)throw e;
     if(performance.now()>=deadline)throw Error('restore_lock_busy');await new Promise(resolve=>setTimeout(resolve,50));}}
   stage='restore_fence';const fencePath=lockPath.slice(0,-7)+'.fence.json';
   const checkedJson=async file=>{const s=await stat(file);if(!s)return null;
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||s.size>16384)throw Error('unsafe_restore_fence');
    const value=await readJson(file,'unsafe_restore_fence');if(!value||typeof value!=='object'||Array.isArray(value))throw Error('unsafe_restore_fence');return value;};
   const validFence=value=>value.schema==='paperclip.workspace-restore-fence.v1'&&value.root===root&&validEpoch(value.epoch)
    &&typeof value.identity==='string'&&/^[a-f0-9]{64}$/.test(value.identity)
    &&typeof value.manifestDigest==='string'&&/^[a-f0-9]{64}$/.test(value.manifestDigest);
   const persisted=await checkedJson(fencePath);if(persisted&&!validFence(persisted))throw Error('unsafe_restore_fence');
   let latest=persisted;
   for(const location of [root,parked,retired]){
    if(!await stat(location))continue;await directory(location);const runtime=path.join(location,'.paperclip-runtime');
    if(!await stat(runtime))continue;await directory(runtime);const receipt=await checkedJson(path.join(runtime,'workspace-restored.json'));
    if(!receipt)continue;
    if(receipt.restorationEpoch===undefined){if(receipt.schema!==undefined)throw Error('unsafe_restore_fence');continue;}
    const pending=receipt.schema==='paperclip.workspace-restore-pending.v1';
    if(receipt.root!==root||!validEpoch(receipt.restorationEpoch)||!(pending?pendingInPlace(receipt)
      :receipt.schema==='paperclip.workspace-restored.v1'&&typeof receipt.identity==='string'&&/^[a-f0-9]{64}$/.test(receipt.identity)
       &&typeof receipt.manifestDigest==='string'&&/^[a-f0-9]{64}$/.test(receipt.manifestDigest)))throw Error('unsafe_restore_fence');
    const observed={schema:'paperclip.workspace-restore-fence.v1',root,epoch:receipt.restorationEpoch,
     identity:pending?receipt.pendingIdentity:receipt.identity,manifestDigest:receipt.manifestDigest};
    if(latest&&observed.epoch===latest.epoch&&(observed.identity!==latest.identity||observed.manifestDigest!==latest.manifestDigest))throw Error('unsafe_restore_fence');
    if(!latest||observed.epoch>latest.epoch)latest=observed;
   }
   if(latest&&restorationEpoch===null)throw Error('restore_fence_required');
   if(latest&&(restorationEpoch<latest.epoch||restorationEpoch===latest.epoch&&(identity!==latest.identity||digest!==latest.manifestDigest)))throw Error('workspace_owner_changed');
   if(restorationEpoch!==null&&(!persisted||persisted.epoch!==restorationEpoch||persisted.identity!==identity||persisted.manifestDigest!==digest)){
    const pending=fencePath+'.'+crypto.randomUUID()+'.tmp';
    try{await fs.writeFile(pending,JSON.stringify({schema:'paperclip.workspace-restore-fence.v1',root,epoch:restorationEpoch,identity,manifestDigest:digest}),{flag:'wx',mode:0o600,flush:true});
     await fs.rename(pending,fencePath);const directory=await fs.open(lockRoot,'r');try{await directory.sync();}finally{await directory.close();}}
    finally{await fs.rm(pending,{force:true});}
   }
   stage='allocation';if(await stat(parked)){if(allowEmpty!=='true')throw Error('unexpected_allocation');await allocation(parked);if(!await stat(root))await fs.rename(parked,root);}
   stage='inspect_root';const prior=await stat(root);if(prior)await directory(root);
   const marker=path.join(root,'.paperclip-runtime','workspace-restored.json');
   if(prior&&await stat(marker)){
    stage='existing_receipt';await directory(path.dirname(marker));const file=await fs.lstat(marker);
    if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>16384)throw Error('unsafe_receipt');
    let receipt=await readJson(marker,'unsafe_receipt');
    if(receipt.schema==='paperclip.workspace-restore-pending.v1'){
     if(!pendingInPlace(receipt))throw Error('unsafe_receipt');
     if(receipt.pendingIdentity===identity?receipt.manifestDigest!==digest:replaceRetired!=='true')throw Error('workspace_owner_changed');
     receipt=await finishInPlace(receipt);
    }
    if(receipt.identity===identity&&receipt.manifestDigest===digest){
     if(await stat(parked)){await allocation(parked);await fs.rm(parked,{recursive:true});}
     await removeRetired();return;}
    if(replaceRetired!=='true')throw Error('workspace_owner_changed');
   }
   stage='inspect_root';
   // Replacing is allowed only for a root the server proved is this workspace's
   // own earlier allocation whose last use ended in a completed final save.
   const retire=Boolean(prior)&&replaceRetired==='true'&&await ownReceipt(root);
   if(retire&&restorationEpoch===null)throw Error('restore_fence_required');
   if(prior&&!retire&&allowEmpty!=='true')throw Error('occupied_root');
   stage='allocation';const retained=prior&&!retire?await allocation(root):[];
   if(!prior&&files.length)throw Error('allocation_missing');
   stage='extract';const staged=await fs.mkdtemp(root+'.restoring-');
   try{
    await require('node:util').promisify(cp.execFile)(process.execPath,[helper,'restore',archive,staged,digest],{maxBuffer:1048576});
    stage='write_receipt';const runtime=path.join(staged,'.paperclip-runtime');await fs.mkdir(runtime,{mode:0o700});
    for(const file of retained)await fs.writeFile(path.join(runtime,file.name),file.content,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(runtime,'workspace-restored.json'),JSON.stringify(completedReceipt(identity,digest,restorationEpoch)),{flag:'wx',mode:0o600});
    stage='publish';if(await fs.realpath(path.dirname(root))!==path.dirname(root))throw Error('unsafe_root');
    const holding=retire?retired:parked;
    if(prior){if(retire){if(!await ownReceipt(root))throw Error('occupied_root');}else await allocation(root);
     if(await stat(holding))throw Error('occupied_parking');
     try{await fs.rename(root,holding);}catch(e){if(!retire||e?.code!=='EXDEV')throw e;await replaceInPlace(staged);return;}}
    try{await fs.rename(staged,root);}catch(e){if(prior&&!await stat(root))await fs.rename(holding,root);throw e;}
    stage='cleanup_parked';if(prior&&!retire){await allocation(parked);await fs.rm(parked,{recursive:true});}
    await removeRetired();
   }finally{await fs.rm(staged,{recursive:true,force:true});}
   }finally{lock.close();}
  })().catch(error=>{process.stderr.write(setupFailure('remote_workspace_restore_failed',stage,error));process.exitCode=1});`;
  await command(input.target, "restore", ["-e", restore, staged.helper, staged.archive, input.remoteCwd,
    input.manifestDigest, input.restorationIdentity, String(input.allowEmptyRoot === true), JSON.stringify(input.allocationFiles ?? []),
    String(input.replaceRetiredRoot === true), input.restorationEpoch === undefined ? "" : String(input.restorationEpoch)]);
  // Publish the restored location before cleanup can fail, stall, or lose its
  // reply. The owner journals this receipt and then reclaims disposable staging.
  return { operationId, stagingRoot: parent, cleanupPending: true };
}
