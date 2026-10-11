import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const providerPackMismatchReasons = ["manifest_mismatch", "artifact_digest_mismatch", "dist_digest_mismatch", "candidate_digest_mismatch", "package_version_mismatch", "opencode_version_mismatch"] as const;
const providerPackCompatibilityReasons = ["node_version_incompatible", "target_mismatch"] as const;
type ProviderPackVerificationReason = typeof providerPackMismatchReasons[number] | typeof providerPackCompatibilityReasons[number] | "timeout" | "command_failed" | "transport_error";

export class RemoteProviderPackVerificationError extends Error {
  constructor(readonly kind: "mismatch" | "incompatible" | "unavailable", readonly reason: ProviderPackVerificationReason, cause?: unknown) {
    super(`runner_remote_provider_${kind === "unavailable" ? "verification_unavailable" : "artifact_incompatible"}: ${reason}`, { cause });
  }
}

/** Only an explicit bounded verifier result proves a mismatch. SSH failures,
 * timeouts and unexpected stderr do not establish anything about cached bytes. */
export function assertRemoteProviderPackVerificationResult(
  result: Pick<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>, "exitCode" | "timedOut" | "stdout" | "stderr">,
  expectedOpenCodeVersion?: string,
): void {
  if (result.timedOut) throw new RemoteProviderPackVerificationError("unavailable", "timeout", result);
  if (result.exitCode === 0) {
    if (expectedOpenCodeVersion !== undefined && result.stdout.trim() !== expectedOpenCodeVersion)
      throw new RemoteProviderPackVerificationError("mismatch", "opencode_version_mismatch", result);
    return;
  }
  if (result.exitCode === 42 && expectedOpenCodeVersion === undefined) {
    for (const reason of providerPackMismatchReasons) {
      if (result.stderr.trim() === `paperclip-provider-pack-verification:${reason}`)
        throw new RemoteProviderPackVerificationError("mismatch", reason, result);
    }
    for (const reason of providerPackCompatibilityReasons) {
      if (result.stderr.trim() === `paperclip-provider-pack-verification:${reason}`)
        throw new RemoteProviderPackVerificationError("incompatible", reason, result);
    }
  }
  throw new RemoteProviderPackVerificationError("unavailable", "command_failed", result);
}

/** Persistent computers can restore a large pack lazily. Give the complete
 * hash walk a bounded cold-read budget; the owner's runner still fences and
 * cancels the command. Version probes keep their separate short deadline. */
export async function verifyRemoteProviderPackArtifacts(input: {
  runner: CommandManagedRuntimeRunner; command: string; args: string[]; cwd: string;
  persistentComputer: boolean;
}): Promise<void> {
  let result;
  try {
    result = await input.runner.execute({ command: input.command, args: input.args, cwd: input.cwd,
      bypassSession: true, timeoutMs: input.persistentComputer ? 120_000 : 30_000 });
  } catch (cause) {
    throw new RemoteProviderPackVerificationError("unavailable", "transport_error", cause);
  }
  assertRemoteProviderPackVerificationResult(result);
}

/** The controller's retained attachment template pins content-addressed paths.
 * Remote manifests may supply bytes, but cannot choose a new code authority. */
export function pinnedComputerProviderPack(input: {
  agentHome: string; identity: Record<string, unknown>; control: unknown;
  provider: { agent: string; model: string };
}): { digest: string; root: string; command: string; sidecar: string } {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const control = object(input.control);
  const identity = object(control.identity);
  const fail = (): never => { throw new Error("runner_remote_provider_pack_provenance_unavailable"); };
  if (control.schema !== "paperclip.runner.durable.control-plane-state.v1" ||
      ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId"].some(key =>
        typeof input.identity[key] !== "string" || !input.identity[key] || identity[key] !== input.identity[key])) return fail();
  let provider = object(object(control.runAttachTemplate).provider);
  if (control.runAttachTemplate === undefined || control.runAttachTemplate === null) {
    // Cold epoch rotation can retain the controller-authored run.attach command
    // without also persisting its attachment template. A failed
    // command still records authorized launch paths; it is not settlement proof.
    const candidates = (Array.isArray(control.commands) ? control.commands : []).map(object)
      .filter(command => ["run.prepare", "run.attach"].includes(String(command.type)) &&
        Number.isSafeInteger(command.controllerSeq) && Number(command.controllerSeq) > 0 &&
        ["pending", "completed", "failed"].includes(String(command.status)))
      .map(command => object(object(command.payload).provider))
      .filter(candidate => candidate.runId === identity.runId && candidate.normalizedSessionId === identity.normalizedSessionId);
    if (!candidates.length) return fail();
    const authority = (candidate: Record<string, unknown>) => JSON.stringify([
      candidate.kind, candidate.provider, candidate.driver, candidate.agent, candidate.model,
      candidate.normalizedSessionId, candidate.sidecarCommand, candidate.sidecarArgs,
    ]);
    if (candidates.some(candidate => authority(candidate) !== authority(candidates[0]!))) return fail();
    provider = candidates[0]!;
  }
  if (provider.kind !== "acpx" || provider.provider !== "acpx" || provider.driver !== "acpx_runtime" ||
      provider.agent !== input.provider.agent || provider.model !== input.provider.model ||
      provider.normalizedSessionId !== identity.normalizedSessionId || typeof provider.sidecarCommand !== "string" ||
      !Array.isArray(provider.sidecarArgs) || provider.sidecarArgs.length !== 1) return fail();
  const match = provider.sidecarCommand.match(/\/provider-packs\/([a-f0-9]{64})\/node_modules\/node\/bin\/node$/);
  if (!match) return fail();
  const digest = `sha256:${match[1]}`;
  const root = computerProviderPackCachePath(input.agentHome, digest);
  const command = `${root}/node_modules/node/bin/node`;
  const sidecar = `${root}/dist/cli/acpx-runtime-sidecar.cjs`;
  if (provider.sidecarCommand !== command || provider.sidecarArgs[0] !== sidecar) return fail();
  return { digest, root, command, sidecar };
}

/** Mirrors the runner's length-prefixed ACPX launch profile v1 digest. */
export function computerAcpxLaunchProfileDigest(input: {
  authorityDigest: string; command: string; commandSha256: string; sidecar: string; sidecarSha256: string;
}): string {
  const digest = createHash("sha256");
  const integer = (n: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(n)); return bytes; };
  const update = (value: string | Buffer) => { const bytes = typeof value === "string" ? Buffer.from(value) : value; digest.update(integer(bytes.length)); digest.update(bytes); };
  update("paperclip.runner.acpx-launch-profile.v1");
  update(input.authorityDigest); update(input.command); update(integer(1)); update(input.sidecar); update(integer(2));
  for (const [path, sha256] of [[input.command, input.commandSha256], [input.sidecar, input.sidecarSha256]].sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0)) {
    update(path!); update(sha256!);
  }
  return `sha256:${digest.digest("hex")}`;
}

export async function readPinnedComputerProviderMetadata(input: {
  runner: CommandManagedRuntimeRunner; packRoot: string; stateDirectory: string;
}): Promise<[unknown, unknown]> {
  for (const path of [input.packRoot, input.stateDirectory]) {
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path)
      throw new Error("runner_remote_provider_pack_provenance_unavailable");
  }
  const result = await input.runner.execute({ command: "python3", args: ["-c", String.raw`
import os,sys,json,stat
values=[]
for path in sys.argv[1:]:
 parts=path.split('/')[1:];parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts[:-1]:
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
   os.close(parent);parent=child
  source=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
  with os.fdopen(source,'rb') as f:
   info=os.fstat(f.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>16777216:raise RuntimeError('invalid retained provider metadata')
   data=f.read(16777217)
   if len(data)>16777216:raise RuntimeError('invalid retained provider metadata')
   values.append(json.loads(data))
 finally:os.close(parent)
print(json.dumps(values))`, posix.join(input.packRoot, "provider-pack.json"),
    posix.join(input.stateDirectory, "acpx-provider-state.json")], bypassSession: true, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("runner_remote_provider_pack_provenance_unavailable");
  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value) || value.length !== 2) throw new Error("runner_remote_provider_pack_provenance_unavailable");
  return [value[0], value[1]];
}

export function assertPinnedComputerProviderState(input: {
  state: unknown; normalizedSessionId: string; launchProfileDigest: string; command: string; sidecar: string;
}): void {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const state = object(input.state); const descriptor = object(state.descriptor);
  if (state.schema !== "paperclip.runner.acpx-provider-state.v3" || state.launchProfileDigest !== input.launchProfileDigest ||
      descriptor.normalizedSessionId !== input.normalizedSessionId || descriptor.sidecarCommand !== input.command ||
      !Array.isArray(descriptor.sidecarArgs) || descriptor.sidecarArgs.length !== 1 || descriptor.sidecarArgs[0] !== input.sidecar)
    throw new Error("runner_remote_provider_pack_provenance_mismatch");
}

export function computerProviderPackCachePath(agentHome: string, digest: string): string {
  if (!posix.isAbsolute(agentHome) || posix.normalize(agentHome) !== agentHome || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("runner_remote_provider_cache_identity_invalid");
  }
  return posix.join(agentHome, ".paperclip-runtime", "paperclip-runner", "provider-packs", digest.slice(7));
}

// Publication never replaces shared bytes. The per-session receipt fences every
// staging command; a retry waits for in-flight writes before replacing its receipt.
// A session never retried can retain its private partial upload for operator cleanup.
const cacheProgram = String.raw`
import os,sys,json,stat,fcntl,ctypes,errno,shutil,subprocess
op,root,session,identity_json=sys.argv[1:5];identity=json.loads(identity_json)
def fail(message):raise RuntimeError(message)
def directory(path):
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in path.split('/'):
   if not part:continue
   if part in ('.','..'):fail('invalid cache path')
   try:os.mkdir(part,0o700,dir_fd=fd)
   except FileExistsError:pass
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
  return fd
 except BaseException:os.close(fd);raise
parent=directory(os.path.dirname(root));name=os.path.basename(root)
try:
 if op=='exists':
  try:
   info=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if not stat.S_ISDIR(info.st_mode):fail('cache is not a real directory')
   print('true')
  except FileNotFoundError:print('false')
  sys.exit(0)
 slot=directory(os.path.join(os.path.dirname(root),'.uploads',session,name))
 lock=os.open('lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=slot)
 if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink!=1:fail('invalid cache lock')
 fcntl.flock(lock,fcntl.LOCK_SH if op=='guard' else fcntl.LOCK_EX)
 def read(name,fd=slot):
  source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  with os.fdopen(source,'rb') as f:
   info=os.fstat(f.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>4096:fail('invalid cache receipt')
   return json.load(f)
 def owned(value):
  return isinstance(value,dict) and value.get('purpose')=='paperclip-provider-pack-upload-v1' and value.get('cacheRoot')==root and value.get('session')==session and isinstance(value.get('attemptId'),str) and len(value['attemptId'])==36 and all(c in '0123456789abcdef-' for c in value['attemptId'])
 def cleanup(value):
  if not owned(value):fail('invalid upload ownership')
  try:fd=os.open(value['attemptId'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=slot)
  except FileNotFoundError:return
  try:
   try:marker=read('owner.json',fd)
   except FileNotFoundError:
    os.rmdir(value['attemptId'],dir_fd=slot);return
   if marker!=value:fail('upload ownership mismatch')
  finally:os.close(fd)
  shutil.rmtree(value['attemptId'],dir_fd=slot)
 try:current=read('current.json')
 except FileNotFoundError:current=None
 if op in ('begin','reap'):
  if current is not None:
   if not owned(current):fail('invalid upload receipt')
   if current.get('ownerId')==identity['ownerId'] and current.get('generation',0)>identity['generation']:fail('stale upload generation')
   cleanup(current)
  if op=='reap':
   if current is not None:os.unlink('current.json',dir_fd=slot)
   sys.exit(0)
  # Reserve the exact attempt before creating its directory. An interrupted
  # begin is recoverable without recursively deleting unmarked user content.
  try:os.stat(identity['attemptId'],dir_fd=slot,follow_symlinks=False);fail('upload already exists')
  except FileNotFoundError:pass
  fd=os.open('current.tmp',os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=slot)
  with os.fdopen(fd,'wb') as f:
   info=os.fstat(f.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:fail('invalid receipt temporary file')
   f.truncate(0);f.write(identity_json.encode());f.flush();os.fsync(f.fileno())
  os.rename('current.tmp','current.json',src_dir_fd=slot,dst_dir_fd=slot);os.fsync(slot)
  os.mkdir(identity['attemptId'],0o700,dir_fd=slot)
  upload=os.open(identity['attemptId'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=slot)
  try:
   marker=os.open('owner.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=upload)
   with os.fdopen(marker,'wb') as f:f.write(identity_json.encode());f.flush();os.fsync(f.fileno())
  finally:os.close(upload)
 elif op=='cleanup':
  cleanup(identity)
  if current==identity:os.unlink('current.json',dir_fd=slot)
 elif op in ('guard','publish'):
  if current!=identity:fail('stale upload generation')
  if op=='guard':sys.exit(subprocess.run(sys.argv[5:],stdin=sys.stdin,pass_fds=(lock,)).returncode)
  upload=os.open(identity['attemptId'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=slot)
  try:
   if read('owner.json',upload)!=identity:fail('upload ownership mismatch')
   libc=ctypes.CDLL(None,use_errno=True)
   if hasattr(libc,'renameat2'):status=libc.renameat2(upload,b'pack',parent,os.fsencode(name),1)
   elif hasattr(libc,'renameatx_np'):status=libc.renameatx_np(upload,b'pack',parent,os.fsencode(name),4)
   else:fail('atomic publication unavailable')
   if status!=0 and ctypes.get_errno() not in (errno.EEXIST,errno.ENOTEMPTY):raise OSError(ctypes.get_errno(),'cache publication failed')
  finally:os.close(upload)
 else:fail('unknown cache operation')
finally:os.close(parent)
`;

export async function prepareComputerProviderPackCache(input: {
  cacheRoot: string;
  sessionKey: string;
  owner: { ownerId: string; generation: number };
  // Must be the computer processRunner: it fences retired owners and places
  // every command in their owner slice, including commands using bypassSession.
  // Cross-owner receipt replacement relies on that admission/retirement fence.
  runner: CommandManagedRuntimeRunner;
  verify: (root: string) => Promise<void>;
  stage: (root: string, runner: CommandManagedRuntimeRunner) => Promise<void>;
}): Promise<"reused" | "published"> {
  const session = createHash("sha256").update(input.sessionKey).digest("hex");
  const identity = { purpose: "paperclip-provider-pack-upload-v1", cacheRoot: input.cacheRoot, session,
    attemptId: randomUUID(), ownerId: input.owner.ownerId, generation: input.owner.generation };
  const args = (op: string) => ["-c", cacheProgram, op, input.cacheRoot, session, JSON.stringify(identity)];
  const operation = async (op: string) => {
    const result = await input.runner.execute({ command: "python3", args: args(op), bypassSession: true, timeoutMs: 180_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`runner_remote_provider_cache_${op}_failed`);
    return result.stdout.trim();
  };
  const verifyShared = async () => {
    try { await input.verify(input.cacheRoot); }
    catch (cause) {
      if (cause instanceof RemoteProviderPackVerificationError && cause.kind === "mismatch")
        throw new Error(`runner_remote_provider_cache_corrupt: ${cause.reason}; ${input.cacheRoot}; stop tasks using this pack and have an operator remove or quarantine this exact cache directory before retrying`, { cause });
      if (cause instanceof RemoteProviderPackVerificationError) throw cause;
      throw new RemoteProviderPackVerificationError("unavailable", "transport_error", cause);
    }
  };
  if (await operation("exists") === "true") {
    await verifyShared();
    await operation("reap");
    return "reused";
  }
  const stagingRoot = posix.join(posix.dirname(input.cacheRoot), ".uploads", session, posix.basename(input.cacheRoot), identity.attemptId, "pack");
  const guardedRunner: CommandManagedRuntimeRunner = {
    execute: (command) => input.runner.execute({ ...command, command: "python3", args: [...args("guard"), command.command, ...(command.args ?? [])] }),
  };
  try {
    await operation("begin");
    await input.stage(stagingRoot, guardedRunner);
    await input.verify(stagingRoot);
    await operation("publish");
    await verifyShared();
    return "published";
  } finally {
    // The marker and attempt identity prevent a delayed cleanup from touching
    // a successor, even when the same session retries under a new generation.
    await operation("cleanup").catch(() => undefined);
  }
}
