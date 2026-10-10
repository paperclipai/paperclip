import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

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
    catch (cause) { throw new Error(`runner_remote_provider_cache_corrupt: ${input.cacheRoot}; stop tasks using this pack and have an operator remove or quarantine this exact cache directory before retrying`, { cause }); }
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
