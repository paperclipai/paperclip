import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNativeAcpxDistributionEntries } from "../../packages/paperclip-runner/src/drivers/acpx/native-distribution-integrity.js";
import { isPerTurnRunProcess, type RunProcessAuthority } from "./native-local-fixtures.js";
import { expectedNativeBootstrap, expectedNativeModuleGuard, KIMI_FAULT_ENTRY, kimiFaultRuntimeContract } from "./kimi-provider-fault-contract.js";

export interface KimiLocalProcess { pid: number; ppid: number; pgid: number; startUs: string; executable: string; executableDev: string; executableIno: string; command: string; argv: string[]; cwd: string; bootId: string }
interface JournalIdentity { pid: number; parent: number; start: string }
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function demand(value: unknown, code: string): asserts value { if (!value) throw new Error(`kimi_local_provider_fault:${code}`); }
export const KIMI_MAC_PROCESS_OBSERVER = String.raw`import ctypes,json,os,struct,subprocess,sys
class Bsd(ctypes.Structure):
 _fields_=[(n,ctypes.c_uint32) for n in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(n,ctypes.c_uint32) for n in ['nfiles','pgid','pjobc','e_tdev','e_tpgid']]+[('nice',ctypes.c_int32),('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
kernel=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
kernel.sysctl.argtypes=[ctypes.POINTER(ctypes.c_int),ctypes.c_uint,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.c_size_t]
def decode_arguments(data):
 if not 8<=len(data)<=2097152:raise RuntimeError('argv_size')
 count=struct.unpack_from('i',data)[0]
 if not 1<=count<=128:raise RuntimeError('argv_count')
 at=data.find(b'\0',4)
 if at<5:raise RuntimeError('argv_executable')
 at+=1
 while at<len(data) and data[at]==0:at+=1
 result=[];total=0
 for _ in range(count):
  end=data.find(b'\0',at)
  if end<0 or end-at>131072:raise RuntimeError('argv_truncated')
  total+=end-at
  if total>262144:raise RuntimeError('argv_bound')
  result.append(data[at:end].decode('utf8'));at=end+1
 return result
def arguments(pid):
 mib=(ctypes.c_int*3)(1,49,pid);size=ctypes.c_size_t()
 if kernel.sysctl(mib,3,None,ctypes.byref(size),None,0)!=0 or not 8<=size.value<=2097152:raise RuntimeError('argv_size')
 buf=ctypes.create_string_buffer(size.value)
 if kernel.sysctl(mib,3,buf,ctypes.byref(size),None,0)!=0:raise RuntimeError('argv_read')
 return decode_arguments(buf.raw[:size.value])
def command(args,maximum=131072):
 r=subprocess.run(args,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,check=True)
 if len(r.stdout)>maximum:raise RuntimeError('bound')
 return r.stdout.decode('utf8').strip()
try:
 pids=json.loads(sys.argv[1])
 if not isinstance(pids,list) or not 0<len(pids)<=128 or any(type(pid)!=int or pid<2 for pid in pids):raise RuntimeError('pids')
 boot=command(['/usr/sbin/sysctl','-n','kern.bootsessionuuid'],128).lower()
 out=[]
 for pid in pids:
  info=Bsd();size=ctypes.sizeof(info)
  if lib.proc_pidinfo(pid,3,0,ctypes.byref(info),size)!=size:continue
  if info.pid!=pid or info.status==5:continue
  buf=ctypes.create_string_buffer(4096)
  if lib.proc_pidpath(pid,buf,len(buf))<=0:continue
  executable=buf.value.decode('utf8')
  args=arguments(pid)
  cmd=command(['/bin/ps','-ww','-p',str(pid),'-o','command='])
  cwd=command(['/usr/sbin/lsof','-a','-p',str(pid),'-d','cwd','-Fn'],16384).splitlines()
  paths=[line[1:] for line in cwd if line.startswith('n')]
  if len(paths)!=1:raise RuntimeError('cwd')
  text=command(['/usr/sbin/lsof','-a','-p',str(pid),'-d','txt','-FfnDi'],131072).splitlines()
  groups=[];current=[]
  for line in text:
   if line.startswith('f'):
    if current:groups.append(current)
    current=[]
   else:current.append(line)
  if current:groups.append(current)
  matches=[g for g in groups if any(line.startswith('n') and os.path.realpath(line[1:])==executable for line in g)]
  if len(matches)!=1:raise RuntimeError('executable')
  devices=[line[1:] for line in matches[0] if line.startswith('D')];inodes=[line[1:] for line in matches[0] if line.startswith('i')]
  if len(devices)!=1 or len(inodes)!=1:raise RuntimeError('executable_inode')
  after=Bsd()
  if lib.proc_pidinfo(pid,3,0,ctypes.byref(after),size)!=size or any(getattr(after,key)!=getattr(info,key) for key in ['pid','ppid','pgid','start_sec','start_usec']):raise RuntimeError('changed')
  out.append({'pid':pid,'ppid':info.ppid,'pgid':info.pgid,'startUs':str(info.start_sec*1000000+info.start_usec),'executable':executable,'executableDev':str(int(devices[0],16)),'executableIno':inodes[0],'command':cmd,'argv':args,'cwd':paths[0],'bootId':boot})
 print(json.dumps(out,separators=(',',':')))
except Exception:
 print(json.dumps({'error':'local_process_inspection_failed'}));sys.exit(1)
`;

/** The local observer and sealed fault closure are qualified on this host only. */
export function supportsKimiLocalProviderFault(host: Pick<NodeJS.Process, "platform" | "arch"> = process): boolean {
  return host.platform === "darwin" && host.arch === "arm64";
}

export function readKimiLocalProcesses(pids: readonly number[]): KimiLocalProcess[] {
  demand(supportsKimiLocalProviderFault(), "supported_platform");
  let output: string;
  try {
    output = execFileSync("/usr/bin/python3", ["-I", "-B", "-c", KIMI_MAC_PROCESS_OBSERVER, JSON.stringify(pids)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
    });
  } catch { throw new Error("kimi_local_provider_fault:process_inspection_failed"); }
  const rows: unknown = JSON.parse(output);
  demand(Array.isArray(rows) && rows.length <= 128 && rows.every(row => row && Number.isSafeInteger(row.pid) && row.pid > 1
    && Number.isSafeInteger(row.ppid) && row.ppid > 0 && Number.isSafeInteger(row.pgid) && row.pgid > 1
    && /^[1-9][0-9]{0,19}$/u.test(row.startUs) && /^[a-f0-9-]{36}$/u.test(row.bootId)
    && /^\d+$/u.test(row.executableDev) && /^\d+$/u.test(row.executableIno)
    && [row.executable, row.command, row.cwd].every(value => typeof value === "string" && value.length > 0 && value.length <= 131072)
    && Array.isArray(row.argv) && row.argv.length > 0 && row.argv.length <= 128 && row.argv.every((value: unknown) => typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= 131072)), "process_shape");
  return rows;
}

export function selectKimiLocalTarget(input: {
  authority: RunProcessAuthority; journal: readonly JournalIdentity[]; processes: readonly KimiLocalProcess[];
  workspacePath: string; guardLoaderSha256: string;
}) {
  const byPid = new Map(input.processes.map(row => [row.pid, row])), root = byPid.get(input.authority.pid);
  const retainedRoot = input.journal.find(row => row.pid === input.authority.pid);
  demand(root && retainedRoot && input.processes.length <= 128 && new Set(input.processes.map(row => row.pid)).size === input.processes.length
    && isPerTurnRunProcess(input.authority, retainedRoot, root.command) && root.pgid === input.authority.groupId
    && Math.floor(Number(root.startUs) / 1_000_000) === Math.floor(Date.parse(input.authority.startedAt) / 1000), "original_run_root");
  const matches = [];
  for (const candidate of input.processes) {
    if (candidate.pid === root.pid || candidate.cwd !== input.workspacePath || candidate.bootId !== root.bootId) continue;
    const match = /^(\/[^\u0000-\u0020]*\/paperclip-acpx-native-[A-Za-z0-9_-]+\/distribution)\/node\/bin\/node$/u.exec(candidate.executable);
    if (!match) continue;
    const distribution = match[1]!, parent = byPid.get(candidate.ppid);
    if (!parent || parent.cwd !== input.workspacePath || parent.bootId !== root.bootId) continue;
    if (!Array.isArray(parent.argv) || parent.argv.length !== 10 || parent.argv[1] !== "--eval" || parent.argv[3] !== distribution
      || JSON.stringify(parent.argv.slice(4)) !== JSON.stringify([".paperclip-native-entry.cjs", "0", "0", "commonjs", "[]", "0"])
      || sha(parent.argv[2]!) !== input.guardLoaderSha256) continue;
    const ancestry = [candidate]; let cursor = candidate;
    while (cursor.pid !== root.pid) {
      const next = byPid.get(cursor.ppid);
      demand(next && ancestry.length < 64 && !ancestry.some(row => row.pid === next.pid)
        && next.bootId === root.bootId && input.journal.some(row => row.pid === next.pid && row.parent === next.ppid
          && Math.floor(Date.parse(row.start) / 1000) === Math.floor(Number(next.startUs) / 1_000_000)), "owned_ancestry");
      ancestry.push(next); cursor = next;
    }
    demand(input.journal.some(row => row.pid === candidate.pid && row.parent === candidate.ppid
      && Math.floor(Date.parse(row.start) / 1000) === Math.floor(Number(candidate.startUs) / 1_000_000)), "unobserved_native_child");
    matches.push({ target: candidate, ancestry, distribution });
  }
  demand(matches.length === 1, "unique_native_child");
  return matches[0]!;
}

function sealedFile(path: string, maximum: number) {
  demand(realpathSync(path) === path, "sealed_realpath");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    demand(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum) && (before.mode & 0o222n) === 0n, "sealed_file");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    demand(BigInt(bytes.length) === before.size && [after, named].every(value => value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs && value.mode === before.mode && value.nlink === before.nlink), "sealed_file_changed");
    return { bytes, digest: sha(bytes), dev: String(before.dev), ino: String(before.ino) };
  } finally { closeSync(fd); }
}

export function terminateKimiLocalProvider(input: { authority: RunProcessAuthority; journal: readonly JournalIdentity[]; workspacePath: string }) {
  demand(supportsKimiLocalProviderFault(), "supported_platform");
  const contract = kimiFaultRuntimeContract("darwin-arm64");
  const pids = input.journal.map(row => row.pid);
  const before = selectKimiLocalTarget({ ...input, processes: readKimiLocalProcesses(pids), guardLoaderSha256: contract.guardLoaderSha256 });
  demand(before.target.pid !== process.pid && before.target.pid !== input.authority.pid, "not_runner");
  for (const path of [before.distribution, dirname(before.distribution)]) {
    const stat = lstatSync(path);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o222) === 0 && realpathSync(path) === path, "snapshot_seal");
  }
  const metadata = JSON.parse(readFileSync(new URL("../../packages/paperclip-runner/provider-assets/kimi/darwin-arm64/native-closure.json", import.meta.url), "utf8"));
  const entries = parseNativeAcpxDistributionEntries(metadata, contract.closureSha256);
  const node = sealedFile(join(before.distribution, "node/bin/node"), 256 * 1024 * 1024);
  const entry = sealedFile(join(before.distribution, KIMI_FAULT_ENTRY), 256 * 1024 * 1024);
  const guard = sealedFile(join(before.distribution, ".paperclip-native-module-guard.cjs"), 4 * 1024 * 1024);
  const bootstrap = sealedFile(join(before.distribution, ".paperclip-native-entry.cjs"), 65536);
  demand(node.dev === before.target.executableDev && node.ino === before.target.executableIno
    && node.digest === contract.nodeSha256 && node.digest === `sha256:${entries.find(row => row.path === "node/bin/node")?.sha256}`
    && entry.digest === `sha256:${entries.find(row => row.path === KIMI_FAULT_ENTRY)?.sha256}`
    && guard.bytes.toString("utf8") === expectedNativeModuleGuard(before.distribution, entries)
    && bootstrap.bytes.toString("utf8") === expectedNativeBootstrap(before.distribution, contract.nodeSha256), "pinned_native_bytes");
  const fresh = selectKimiLocalTarget({ ...input, processes: readKimiLocalProcesses(pids), guardLoaderSha256: contract.guardLoaderSha256 });
  demand(JSON.stringify(fresh) === JSON.stringify(before), "native_identity_changed");
  process.kill(fresh.target.pid, "SIGKILL");
  const identity = ({ pid, ppid, pgid, startUs, bootId }: KimiLocalProcess) => ({ pid, ppid, pgid, startUs, bootId });
  return { schema: "paperclip.e2e.kimi-local-provider-death.v1", runId: input.authority.runId, target: identity(before.target), ancestry: before.ancestry.map(identity),
    nodeSha256: node.digest, entrypointSha256: entry.digest, closureSha256: contract.closureSha256,
    guardLoaderSha256: contract.guardLoaderSha256, guardSha256: guard.digest, bootstrapSha256: bootstrap.digest,
    entrypointAttribution: "pinned_native_bootstrap_parent", signalled: true, signal: "SIGKILL", targetKind: "kimi_native_child", workerSignalled: false };
}
