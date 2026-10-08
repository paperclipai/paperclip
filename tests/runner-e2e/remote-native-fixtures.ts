import { canonicalRemoteCopilotCommand, copilotDeathArguments, selectOwnedCopilotProcess } from "./copilot-provider-death.js";
import { createHash, randomBytes } from "node:crypto";
import { watch, lstatSync } from "node:fs";
import { posix } from "node:path";

export const REMOTE_FIXTURE_DAYTONA_SDK_VERSION = "0.203.0";
const NODE = "/opt/paperclip-runner/provider-pack/node_modules/node/bin/node";
const MAX_OUTPUT = 256 * 1024;
const TEARDOWN_RESERVE_MS = 15_000;
const LEASE_READMISSION_BUDGET_MS = 10_000;
const RUNTIME_READY_BUDGET_MS = 12_000;
const INSTALL_BUDGET_MS = 27_000;
// Lease activation can arrive late. Reserve each pre-install operation as well
// as installation and teardown; the caller subtracts this from the same deadline.
export const REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS = LEASE_READMISSION_BUDGET_MS
  + RUNTIME_READY_BUDGET_MS + INSTALL_BUDGET_MS + TEARDOWN_RESERVE_MS;
const CLOSE_GRACE_MS = 10_000;
// createRunnerdBackend stages its verified executable, pack symlink, mutable
// sessions, homes and injected context beneath this exact path. Qualification
// covers user workspace files, not these controller/provider runtime internals.
// The sentinel and all other .paperclip-runtime entries remain in scope.
const RUNTIME_RELATIVE = ".paperclip-runtime/paperclip-runner";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (condition: unknown, code: string): void => { if (!condition) throw new Error(`remote_native_fixture:${code}`); };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const id = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
function relative(value: string): string {
  fail(value.length <= 240 && /^[a-zA-Z0-9._/-]+$/u.test(value) && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "unsafe_relative_target");
  return value;
}
// Only closed diagnostic enums cross the remote boundary; SDK errors and output
// are never retained. These diagnostics explain failed evidence, not qualification.
const RPC_PHASES = ["runtime-ready", "install", "wait", "close", "arm", "publish", "snapshot", "attached", "release-attached", "read", "inject-loss", "provider-death"] as const;
const RPC_CODES = ["node_identity", "sentinel_type", "sentinel", "cwd", "runtime_root_identity", "runtime_binary_identity", "proc_bound", "ambiguous_run_root", "runtime_not_ready", "runtime_identity_changed", "invalid_proc_identity", "invalid_proc_fields", "socket_error", "socket_timeout", "output_bound", "rpc_deadline", "remote_unknown", "transport_failure", "invalid_response", "readiness_deadline", "terminal_evidence_incomplete"] as const;
type RpcPhase = typeof RPC_PHASES[number];
type RpcCode = typeof RPC_CODES[number];
interface RpcDiagnostic { phase: RpcPhase; code: RpcCode }
class RemoteFixtureError extends Error {
  constructor(message: string, readonly diagnostic: RpcDiagnostic, options?: ErrorOptions) { super(message, options); }
}
export function remoteNativeFixtureDiagnostics(error: unknown): RpcDiagnostic[] {
  const result: RpcDiagnostic[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth++) {
    if (current instanceof RemoteFixtureError) result.push({ ...current.diagnostic });
  }
  return result;
}
export interface RemoteNativeAuthority { companyId: string; environmentId: string; runId: string; leaseId: string; sandboxId: string; image: string }
export interface RemoteNativeBinding extends RemoteNativeAuthority { remoteCwd: string }
export interface RemoteProcessIdentity { pid: number; ppid: number; startTicks: string; bootId: string }
const TERMINAL_FAILURE_CODES = ["ambiguous_run_root", "run_root_changed", "process_pid_reused", "workspace_watch_unknown_entry", "setup_file_changed", "setup_file_unreadable", "workspace_watch_entry_bound", "workspace_watch_new_directory", "workspace_watch_read_failure", "workspace_watch_io_failure", "receipt_output_bound", "attached_child_live", "terminal_snapshot_failed", "process_sample_failed"] as const;
const INCOMPLETE_REASONS = ["multiple_run_roots", "run_root_changed", "process_identity_reused", "workspace_watch_incomplete", "setup_file_changed", "workspace_event_bound", "workspace_directory_added", "retirement_snapshot_failed", "process_sample_failed", "control_bound", "observer_ttl"] as const;

export interface RemoteNativeSnapshot {
  binding: RemoteNativeBinding;
  observedAtMs: number;
  observedMonotonicNs: string;
  receivedAtMs: number;
  complete: boolean;
  incompleteReasons?: readonly string[];
  workspace: Record<string, string>;
  targets: Record<string, { absent: boolean; sha256: string | null; parent: { dev: string; ino: string }; mutationCount: number; complete: boolean }>;
  watcher: { complete: boolean; targetMutationCount: number; workspaceMutationCount: number };
  processes: { captured: boolean; root: RemoteProcessIdentity | null; journal: RemoteProcessIdentity[]; live: number[] };
  scope: {
    kind: "user_workspace";
    excludedRuntime: { relativePath: string; absolutePath: string; dev: string; ino: string; runnerExecutableSha256: string };
    observedPrpEnvironmentLeaseId: string;
    prpEnvironmentLeaseIdVerified: false;
  };
  setup: { path: string; sha256: string | null; published: boolean };
  attached: { connections: number; failure: string | null; commandExit: { code: number; observedAtMs: number; observedMonotonicNs: string } | null; markerWrittenAtMs: number | null; markerWrittenMonotonicNs: string | null; clientExitedAtMs: number | null; clientExitedMonotonicNs: string | null } | null;
}
/** Structural subset of pinned SDK0.203.0; caller supplies its authenticated
 * client. No create/list/delete or arbitrary remote command API is exposed. */
export interface RemoteFixtureDaytona {
  get(id: string): Promise<{ id: string; labels?: Record<string, string>; process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ exitCode: number; result: string }>;
  } }>;
}
export interface RemoteFixtureApi { get<T>(path: string, options?: { timeout: number }): Promise<T> }

/** Linux /proc identity uses boot ID + start ticks, never PID alone. */
export function parseRemoteProcStat(pid: number, stat: string, bootId: string): RemoteProcessIdentity & { group: number; state: string } {
  const close = stat.lastIndexOf(") ");
  if (!Number.isSafeInteger(pid) || pid < 2 || close < 0 || !stat.startsWith(`${pid} (`) || !/^[a-f0-9-]{36}$/u.test(bootId)) throw new Error("invalid_proc_identity");
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  if (!/^\d+$/u.test(fields[19] ?? "") || !/^\d+$/u.test(fields[1] ?? "") || !/^\d+$/u.test(fields[2] ?? "")) throw new Error("invalid_proc_fields");
  return { pid, ppid: Number(fields[1]), group: Number(fields[2]), state: fields[0]!, startTicks: fields[19]!, bootId };
}
export function isRemoteRunRoot(argv: string[], runId: string, process: RemoteProcessIdentity & { group: number }): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId) || process.group !== process.pid || !argv[0]?.endsWith("/paperclip-runnerd")) return false;
  return [["--run-id", runId], ["--lifecycle-mode", "per_turn"]].every(([flag, value]) => {
    const at = argv.indexOf(flag!); return at > 0 && argv.lastIndexOf(flag!) === at && argv[at + 1] === value;
  });
}
/** Shared by the real remote observer and local deterministic tests. */
export function createRemoteTargetWatch(directory: string, name: string, io = { watch, lstatSync }) {
  const before = io.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe_watch_parent");
  let complete = true, mutations = 0, events = 0, sealed = false;
  const watcher = io.watch(directory, (_kind, filename) => {
    if (sealed) return;
    events++;
    if (filename === null || events > 4096) complete = false;
    else if (String(filename) === name) mutations++;
  });
  watcher.on("error", () => { complete = false; });
  return {
    snapshot() {
      let deliveryComplete = true;
      try {
        const after = io.lstatSync(directory, { bigint: true });
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) complete = false;
        if ((after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) && events === 0) deliveryComplete = false;
      } catch { complete = false; }
      return { complete: complete && deliveryComplete, mutationCount: mutations, parent: { dev: String(before.dev), ino: String(before.ino) } };
    },
    close() { this.snapshot(); sealed = true; watcher.close(); },
  };
}

// Only this closed Node program executes through the SDK. The observer has no
// general command endpoint. Its control nonce is never given to the provider.
const OBSERVER = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),cp=require('node:child_process');
const config=JSON.parse(Buffer.from(process.argv[2],'base64').toString());
const parseStat=PARSE_STAT;const runRoot=RUN_ROOT;const watchTarget=WATCH_TARGET;const selectCopilot=SELECT_COPILOT;const canonicalCopilot=CANONICAL_COPILOT;const copilotArgs=COPILOT_ARGS;let providerDeathDispatched=false;
const hash=x=>'sha256:'+crypto.createHash('sha256').update(x).digest('hex');
const cwdStat=fs.lstatSync(config.binding.remoteCwd,{bigint:true}),rootStat=fs.lstatSync(config.root,{bigint:true}),scriptStat=fs.lstatSync(__filename,{bigint:true}),scriptHash=hash(fs.readFileSync(__filename));
const runtimeRoot=path.join(config.binding.remoteCwd,config.runtimeRelative),runtimeStat=fs.lstatSync(runtimeRoot,{bigint:true});if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink()||fs.realpathSync(runtimeRoot)!==runtimeRoot)throw Error('runtime_root_identity');let observedPrpEnvironmentLeaseId=null;
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const targets=new Map();let complete=true,sealed=false,root=null,attached=null,child=null,client=null,childTimer=null;const incompleteReasons=new Set();const failureCodes=new Set();function incomplete(code){complete=false;failureCodes.add(code)}function markIncomplete(reason){complete=false;incompleteReasons.add(reason)}
const journal=new Map(),sockets=new Set(),waiters=new Set(),armWaiters=new Set();let observedRootCount=0,publishedHash=null,finalReceipt=null,retiring=false;
function identity(pid){return parseStat(pid,fs.readFileSync('/proc/'+pid+'/stat','utf8'),boot)}
function deathCommand(pid){const command=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean);if(!/^\/proc\/self\/fd\/(?:3|7)$/.test(command[0]??''))return command;const executable=fs.realpathSync('/proc/'+pid+'/exe'),s=fs.statSync('/proc/'+pid+'/exe',{bigint:true}),fd='/proc/'+pid+'/fd/'+command[0].split('/').at(-1),d=fs.statSync(fd,{bigint:true});return canonicalCopilot(command,executable,{dev:String(s.dev),ino:String(s.ino)},{path:fs.realpathSync(fd),dev:String(d.dev),ino:String(d.ino)})}
function table(){const ids=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)&&Number(x)>1);if(ids.length>4096)throw Error('process_bound');return ids.flatMap(x=>{try{return [identity(Number(x))]}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return [];throw e}})}
function sample(){
 const all=table();const candidates=[];
 for(const p of all){if(p.state==='Z')continue;let argv;try{argv=fs.readFileSync('/proc/'+p.pid+'/cmdline').toString().split('\0').filter(Boolean)}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw e}
  if(runRoot(argv,config.binding.runId,p)){const at=argv.indexOf('--environment-lease-id'),stateAt=argv.indexOf('--state-dir');if(at<1||argv.lastIndexOf('--environment-lease-id')!==at||!/^[-a-zA-Z0-9._:]{1,256}$/.test(argv[at+1]??''))throw Error('process_prp_identity_shape');if(argv[0]!==path.join(runtimeRoot,'bin','paperclip-runnerd')||stateAt<1||argv.lastIndexOf('--state-dir')!==stateAt||!argv[stateAt+1]?.startsWith(runtimeRoot+'/sessions/')||!/^([a-f0-9]{64})\/runner$/.test(argv[stateAt+1].slice((runtimeRoot+'/sessions/').length)))throw Error('process_runtime_binding');if(observedPrpEnvironmentLeaseId!==null&&observedPrpEnvironmentLeaseId!==argv[at+1])throw Error('process_prp_identity_changed');observedPrpEnvironmentLeaseId=argv[at+1];candidates.push(p);}}
 if(candidates.length>1)incomplete('ambiguous_run_root');
 if(!root&&candidates.length===1){if(hash(fs.readFileSync('/proc/'+candidates[0].pid+'/exe'))!==config.runnerdSha256)throw Error('runner_binary_identity');root=candidates[0];journal.set(root.pid,root);observedRootCount++;}
 if(root&&candidates.some(p=>p.pid!==root.pid||p.startTicks!==root.startTicks))incomplete('run_root_changed');
 let changed=true;while(changed){changed=false;for(const p of all){const parent=journal.get(p.ppid);if(!journal.has(p.pid)&&((parent&&all.some(q=>q.pid===parent.pid&&q.startTicks===parent.startTicks))||(root&&p.group===root.pid))){if(journal.size>=512)throw Error('journal_bound');journal.set(p.pid,p);changed=true;}}}
 if(all.some(p=>journal.has(p.pid)&&journal.get(p.pid).startTicks!==p.startTicks))incomplete('process_pid_reused');
 const live=all.filter(p=>journal.get(p.pid)?.startTicks===p.startTicks&&p.state!=='Z').map(p=>p.pid);
 if(client&&!all.some(p=>p.pid===client.pid&&p.startTicks===client.startTicks&&p.state!=='Z')&&attached&&!attached.clientExitedAtMs){attached.clientExitedAtMs=Date.now();attached.clientExitedMonotonicNs=process.hrtime.bigint().toString();}
 return {captured:root!==null,root,journal:[...journal.values()],live};
}
function guard(){const rs=fs.lstatSync(runtimeRoot,{bigint:true});if(!rs.isDirectory()||rs.isSymbolicLink()||rs.dev!==runtimeStat.dev||rs.ino!==runtimeStat.ino||fs.realpathSync(runtimeRoot)!==runtimeRoot)throw Error('runtime_root_replaced');const s=fs.lstatSync(config.root,{bigint:true});if(s.dev!==rootStat.dev||s.ino!==rootStat.ino||!s.isDirectory()||s.isSymbolicLink()||hash(fs.readFileSync(__filename))!==scriptHash||fs.lstatSync(__filename,{bigint:true}).ino!==scriptStat.ino)throw Error('observer_identity_changed');
 const st=fs.lstatSync(config.sentinel.path);if(!st.isFile()||st.isSymbolicLink()||st.size>16384||fs.realpathSync(config.sentinel.path)!==config.sentinel.path)throw Error('sentinel_type');const sentinel=JSON.parse(fs.readFileSync(config.sentinel.path,'utf8'));if(sentinel.version!==1||sentinel.provider!=='daytona'||sentinel.token!==config.sentinel.token||sentinel.companyId!==config.binding.companyId||sentinel.environmentId!==config.binding.environmentId)throw Error('sentinel_changed');
 const c=fs.lstatSync(config.binding.remoteCwd,{bigint:true});if(c.dev!==cwdStat.dev||c.ino!==cwdStat.ino||!c.isDirectory()||c.isSymbolicLink()||fs.realpathSync(config.binding.remoteCwd)!==config.binding.remoteCwd)throw Error('workspace_replaced');}
function readSafe(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>65536n)throw Error('file_bound_or_type');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(p,{bigint:true});if(before.dev!==named.dev||before.ino!==named.ino||named.isSymbolicLink()||before.size!==after.size||before.mtimeNs!==after.mtimeNs||BigInt(bytes.length)!==before.size)throw Error('file_changed');return bytes}finally{fs.closeSync(fd)}}
function file(p){try{const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isFile()||s.size>65536)throw Error('file_bound_or_type');return {absent:false,sha256:hash(readSafe(p))}}catch(e){if(e.code==='ENOENT')return {absent:true,sha256:null};throw e}}
function workspace(){const result={};let count=0,bytes=0;function visit(dir,prefix){for(const name of fs.readdirSync(dir).sort()){if(++count>512)throw Error('workspace_entry_bound');const full=path.join(dir,name),rel=prefix+name,s=fs.lstatSync(full);if(rel===config.runtimeRelative)continue;if(rel===config.actionFile){if(!publishedHash||file(full).sha256!==publishedHash)throw Error('setup_file_changed');continue;}if(s.isSymbolicLink())throw Error('workspace_symlink');if(s.isDirectory()){result[rel]='directory';visit(full,rel+'/')}else if(s.isFile()){bytes+=s.size;if(s.size>65536||bytes>4194304)throw Error('workspace_byte_bound');result[rel]=hash(readSafe(full))}else throw Error('workspace_special_file')}}visit(config.binding.remoteCwd,'');return result}
function snapshot(){guard();verifyWorkspaceWatchRoots();const processes=sample(),out={};let watchComplete=complete,total=0;for(const [name,t] of targets){const status=t.watch.snapshot();out[name]={...file(t.path),...status};watchComplete&&=status.complete;total+=status.mutationCount}return {binding:config.binding,observedAtMs:Date.now(),observedMonotonicNs:process.hrtime.bigint().toString(),complete:complete&&watchComplete,failureCodes:[...failureCodes],incompleteReasons:[...incompleteReasons],workspace:workspace(),targets:out,watcher:{complete:watchComplete,targetMutationCount:total,workspaceMutationCount},processes,scope:{kind:'user_workspace',excludedRuntime:{relativePath:config.runtimeRelative,absolutePath:runtimeRoot,dev:String(runtimeStat.dev),ino:String(runtimeStat.ino),runnerExecutableSha256:config.runnerdSha256},observedPrpEnvironmentLeaseId,prpEnvironmentLeaseIdVerified:false},setup:{path:config.actionFile,sha256:publishedHash,published:publishedHash!==null},attached}}
for(const name of config.targets){const p=path.join(config.binding.remoteCwd,name);if(fs.realpathSync(path.dirname(p))!==path.dirname(p))throw Error('target_parent_symlink');targets.set(name,{path:p,watch:watchTarget(path.dirname(p),path.basename(p),{watch:fs.watch,lstatSync:fs.lstatSync})})}
if(config.crossRoot){const p=path.join(config.root,'cross-root-target');fs.writeFileSync(p,config.crossRoot.initialText,{flag:'wx',mode:0o600});targets.set('@cross-root',{path:p,watch:watchTarget(config.root,'cross-root-target',{watch:fs.watch,lstatSync:fs.lstatSync})})}
let workspaceMutationCount=0;const directoryWatches=[];
function watchDirectory(directory,prefix=''){if(directoryWatches.length>=512)throw Error('watch_directory_bound');const before=fs.lstatSync(directory,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())throw Error('watch_directory_identity');const handle=fs.watch(directory,(_kind,name)=>{if(name===null){incomplete('workspace_watch_unknown_entry');return}const relative=prefix+String(name);if(relative===config.runtimeRelative)return;if(relative===config.actionFile){try{if(!publishedHash||file(path.join(config.binding.remoteCwd,config.actionFile)).sha256!==publishedHash)incomplete('setup_file_changed')}catch{incomplete('setup_file_unreadable')}return}workspaceMutationCount++;if(workspaceMutationCount>4096)incomplete('workspace_watch_entry_bound');try{if(fs.lstatSync(path.join(directory,String(name))).isDirectory())incomplete('workspace_watch_new_directory')}catch(e){if(e.code!=='ENOENT')incomplete('workspace_watch_read_failure')}});handle.on('error',()=>{incomplete('workspace_watch_io_failure')});directoryWatches.push({directory,before,handle});for(const name of fs.readdirSync(directory)){const rel=prefix+name;if(rel===config.runtimeRelative)continue;const full=path.join(directory,name),s=fs.lstatSync(full);if(s.isSymbolicLink())throw Error('workspace_symlink');if(s.isDirectory())watchDirectory(full,rel+'/')}}
watchDirectory(config.binding.remoteCwd);
const workspaceWatch={close(){for(const item of directoryWatches)item.handle.close()}};
function verifyWorkspaceWatchRoots(){for(const item of directoryWatches){const after=fs.lstatSync(item.directory,{bigint:true});if(after.dev!==item.before.dev||after.ino!==item.before.ino||!after.isDirectory()||after.isSymbolicLink())throw Error('workspace_watch_root_replaced')}}
function publicSnapshot(){const result=snapshot();if(result.attached)result.attached={connections:attached.connections,failure:attached.failure,commandExit:attached.commandExit,markerWrittenAtMs:attached.markerWrittenAtMs,markerWrittenMonotonicNs:attached.markerWrittenMonotonicNs,clientExitedAtMs:attached.clientExitedAtMs,clientExitedMonotonicNs:attached.clientExitedMonotonicNs};return result}
function seal(){if(sealed)return;sealed=true;workspaceWatch.close();for(const t of targets.values())t.watch.close();clearInterval(observer);finalReceipt=publicSnapshot();finalReceipt.files={};for(const [name,t] of targets){if(!file(t.path).absent)finalReceipt.files[name]=readSafe(t.path).toString('base64');}if(Buffer.byteLength(JSON.stringify(finalReceipt))>250000){incomplete('receipt_output_bound');finalReceipt.complete=false;finalReceipt.failureCodes=[...failureCodes];finalReceipt.files={};}if(child&&child.exitCode===null&&child.signalCode===null){incomplete('attached_child_live');finalReceipt.complete=false;finalReceipt.failureCodes=[...failureCodes];}for(const socket of waiters)socket.end(JSON.stringify({ok:true,result:finalReceipt})+'\n');waiters.clear();setTimeout(()=>shutdown(null),250);}
const observer=setInterval(()=>{try{const p=sample();if(p.captured&&p.live.length===0&&!retiring){retiring=true;setTimeout(()=>{try{const end=sample();if(end.live.length===0)seal();else retiring=false}catch{incomplete('terminal_snapshot_failed')}},100)}}catch{incomplete('process_sample_failed')}},25);
const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer='';socket.on('data',data=>{buffer+=data;if(Buffer.byteLength(buffer)>8192){socket.destroy();complete=false;return}if(!buffer.includes('\n'))return;socket.removeAllListeners('data');try{const r=JSON.parse(buffer);if(r.nonce!==config.nonce)throw Error('control_identity');guard();let result;
 if(r.op==='snapshot')result=finalReceipt??publicSnapshot();
 else if(r.op==='wait'){if(finalReceipt)result=finalReceipt;else{if(waiters.size)throw Error('duplicate_receipt_channel');waiters.add(socket);for(const arm of armWaiters)arm.end(JSON.stringify({ok:true,result:{armed:true,sealed:false}})+'\n');armWaiters.clear();socket.on('close',()=>waiters.delete(socket));return}}
 else if(r.op==='arm'){if(waiters.size)result={armed:true,sealed};else{armWaiters.add(socket);socket.on('close',()=>armWaiters.delete(socket));return}}
 else if(r.op==='publish'){if(sealed||publishedHash||r.path!==config.actionFile||typeof r.text!=='string'||Buffer.byteLength(r.text)>16384)throw Error('publish_bound');const p=path.join(config.binding.remoteCwd,config.actionFile);if(fs.realpathSync(path.dirname(p))!==path.dirname(p))throw Error('publish_parent');publishedHash=hash(r.text);try{fs.writeFileSync(p,r.text,{flag:'wx',mode:0o600})}catch(e){publishedHash=null;throw e}result={path:r.path,sha256:publishedHash,published:true};}
 else if(r.op==='read'){const p=r.path==='@cross-root'&&config.crossRoot?path.join(config.root,'cross-root-target'):path.join(config.binding.remoteCwd,r.path);if(r.path!=='@cross-root'&&!config.targets.includes(r.path))throw Error('unregistered_read');const status=file(p);if(status.absent)throw Error('file_missing');result={...status,base64:readSafe(p).toString('base64')};}
 else if(r.op==='attached'){if(attached||sealed)throw Error('attached_already_configured');if(!config.targets.includes(r.marker)||!Number.isInteger(r.delayMs)||r.delayMs<100||r.delayMs>8000||(r.waitForFinishAttempt!==undefined&&typeof r.waitForFinishAttempt!=='boolean'))throw Error('attached_bounds');
  attached={waitForFinishAttempt:r.waitForFinishAttempt===true,releasedAtMs:null,connections:0,failure:null,commandExit:null,markerWrittenAtMs:null,markerWrittenMonotonicNs:null,clientExitedAtMs:null,clientExitedMonotonicNs:null};
  const clientScript=path.join(config.root,'client.cjs'),clientSocket=path.join(config.root,'attached.sock');
  fs.writeFileSync(clientScript,ATTACHED_CLIENT.replace('15000',attached.waitForFinishAttempt?'45000':'15000'),{flag:'wx',mode:0o400});
  const srv=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});let b='';s.on('data',d=>{b+=d;if(b.length>1024){s.destroy();attached.failure='client_bound';return}if(!b.includes('\n'))return;s.removeAllListeners('data');try{const q=JSON.parse(b);attached.connections++;if(q.nonce!==r.clientNonce||attached.connections!==1)throw Error('client_identity');client=identity(q.pid);sample();if(journal.get(q.pid)?.startTicks!==client.startTicks)throw Error('client_not_owned_by_run');const argv=fs.readFileSync('/proc/'+q.pid+'/cmdline').toString().split('\0');if(argv[1]!==clientScript||argv[2]!==clientSocket||argv[3]!==r.clientNonce)throw Error('client_argv');
   const childScript=attached.waitForFinishAttempt?"const deadline=setTimeout(()=>process.exit(3),30000);process.stdin.once('data',b=>{if(b.toString()!=='release\\n')process.exit(2);clearTimeout(deadline);setTimeout(()=>process.exit(0),"+r.delayMs+")});":'setTimeout(()=>process.exit(0),'+r.delayMs+')';child=cp.spawn(process.execPath,['-e',childScript],{env:{PATH:'/usr/bin:/bin'},stdio:attached.waitForFinishAttempt?['pipe','ignore','ignore']:'ignore'});child.once('error',()=>{attached.failure='child_start';s.destroy()});child.once('exit',(code,signal)=>{attached.commandExit={code:code??-1,observedAtMs:Date.now(),observedMonotonicNs:process.hrtime.bigint().toString()};if(code!==0||signal){attached.failure='child_failed';s.destroy();return}try{fs.writeFileSync(path.join(config.binding.remoteCwd,r.marker),r.markerText,{flag:'wx'});attached.markerWrittenAtMs=Date.now();attached.markerWrittenMonotonicNs=process.hrtime.bigint().toString();s.end(JSON.stringify({code:0})+'\n')}catch{attached.failure='marker_failed';s.destroy()}});
  }catch{attached.failure='client_rejected';s.destroy()}})});srv.listen(clientSocket);attached.server=srv;result={clientScript,clientSocket};
 }
 else if(r.op==='release-attached'){if(sealed||!publishedHash||!attached?.waitForFinishAttempt||attached.releasedAtMs!==null||!child?.stdin||child.exitCode!==null||child.signalCode!==null)throw Error('attached_release_boundary');attached.releasedAtMs=Date.now();child.stdin.end('release\n');result={releasedAtMs:attached.releasedAtMs};}
 else if(r.op==='provider-death'){
  if(providerDeathDispatched||!publishedHash||sealed)throw Error('death_boundary');
  const observed=sample();if(!complete||!observed.captured)throw Error('death_owner');
  const argv=new Map(observed.live.map(pid=>[pid,deathCommand(pid)]));
  const selected=selectCopilot(root.pid,observed.journal.map(p=>({...p,parent:p.ppid})),observed.live,argv,copilotArgs);
  const current=identity(selected.pid),currentRoot=identity(root.pid),command=deathCommand(selected.pid);
  if(current.bootId!==selected.bootId||current.startTicks!==selected.startTicks||currentRoot.startTicks!==root.startTicks||JSON.stringify(command)!==JSON.stringify(argv.get(selected.pid))||fs.realpathSync('/proc/'+selected.pid+'/exe')!==command[0])throw Error('death_identity');
  providerDeathDispatched=true;const dispatchedMonotonicNs=process.hrtime.bigint().toString();process.kill(selected.pid,'SIGKILL');
  result={schema:'paperclip.e2e.copilot-owned-provider-death.v1',root,child:current,signal:'SIGKILL',commandSha256:hash(JSON.stringify(command)),dispatchedMonotonicNs};
 }
 else if(r.op==='inject-loss'){const p=sample();if(sealed||!complete||!publishedHash||!root||!p.live.includes(root.pid))throw Error('loss_owner_missing');const original=journal.get(root.pid);if(!original||original.startTicks!==root.startTicks||original.bootId!==root.bootId)throw Error('loss_owner_changed');
  const program="import os,signal,sys\npid=int(sys.argv[1]);fd=os.pidfd_open(pid)\ntry:\n s=open('/proc/'+str(pid)+'/stat').read();ticks=s[s.rfind(') ')+2:].split()[19];boot=open('/proc/sys/kernel/random/boot_id').read().strip()\n if ticks!=sys.argv[2] or boot!=sys.argv[3]:raise RuntimeError('identity changed')\n signal.pidfd_send_signal(fd,signal.SIGKILL)\nfinally:os.close(fd)";
  const killed=cp.spawnSync('/usr/bin/python3',['-c',program,String(root.pid),root.startTicks,root.bootId],{env:{PATH:'/usr/bin:/bin'},stdio:'pipe',timeout:3000});if(killed.status!==0)throw Error('loss_not_injected');result={root:original,signal:'SIGKILL',observedMonotonicNs:process.hrtime.bigint().toString()};}
 else if(r.op==='finish'){result=snapshot();if(!result.complete||!result.processes.captured||result.processes.live.length)throw Error('retirement_unproven');sealed=true;workspaceWatch.close();for(const t of targets.values())t.watch.close();}
 else if(r.op==='close'){shutdown(socket);return;}
 else throw Error('unknown_operation');
 // Socket handles never cross the evidence boundary.
 if(result?.attached)result={...result,attached:{connections:attached.connections,failure:attached.failure,commandExit:attached.commandExit,markerWrittenAtMs:attached.markerWrittenAtMs,markerWrittenMonotonicNs:attached.markerWrittenMonotonicNs,clientExitedAtMs:attached.clientExitedAtMs,clientExitedMonotonicNs:attached.clientExitedMonotonicNs}};
 socket.end(JSON.stringify({ok:true,result})+'\n');
 }catch{socket.end(JSON.stringify({ok:false,error:'observer_evidence_incomplete'})+'\n')}})});
let closing=false;async function shutdown(reply){if(closing){reply?.end(JSON.stringify({ok:false,error:'closing'})+'\n');return}closing=true;sealed=true;workspaceWatch.close();for(const t of targets.values())t.watch.close();clearInterval(observer);let settled=true;try{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const exited=new Promise(resolve=>child.once('exit',resolve));await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2000))]);}settled=child.exitCode!==null||child.signalCode!==null;}if(reply)reply.end(JSON.stringify({ok:settled,result:{closed:settled}})+'\n');}finally{for(const s of sockets)if(s!==reply)s.destroy();server.close();if(attached?.server)attached.server.close();setTimeout(()=>{reply?.destroy();if(settled){const current=fs.lstatSync(config.root,{bigint:true});if(current.dev===rootStat.dev&&current.ino===rootStat.ino&&!current.isSymbolicLink())fs.rmSync(config.root,{recursive:true,force:true});else settled=false;}process.exit(settled?0:2)},100)}}
server.listen(path.join(config.root,'control.sock'));setTimeout(()=>{markIncomplete("observer_ttl");shutdown(null)},config.observerTtlMs).unref();
`;
const ATTACHED_CLIENT = String.raw`const net=require('node:net');const s=net.connect(process.argv[2]);let b='';s.setTimeout(15000,()=>process.exit(3));s.on('error',()=>process.exit(4));s.on('connect',()=>s.write(JSON.stringify({nonce:process.argv[3],pid:process.pid})+'\n'));s.on('data',x=>{b+=x;if(b.length>1024)process.exit(6);if(b.includes('\n')){const r=JSON.parse(b);s.end();process.exit(r.code===0?0:5)}});`;
function observerSource() {
  return OBSERVER.replace("PARSE_STAT", () => parseRemoteProcStat.toString()).replace("RUN_ROOT", () => isRemoteRunRoot.toString())
    .replace("SELECT_COPILOT", () => selectOwnedCopilotProcess.toString()).replace("CANONICAL_COPILOT", () => canonicalRemoteCopilotCommand.toString()).replace("COPILOT_ARGS", () => JSON.stringify(copilotDeathArguments)).replace("WATCH_TARGET", () => createRemoteTargetWatch.toString()).replace("ATTACHED_CLIENT", () => JSON.stringify(ATTACHED_CLIENT));
}
const RPC = String.raw`const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),crypto=require('node:crypto');const r=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const hash=x=>'sha256:'+crypto.createHash('sha256').update(x).digest('hex');
const startedAt=Date.now();if(!Number.isInteger(r.timeoutMs)||r.timeoutMs<1000||r.timeoutMs>300000)throw Error('rpc_deadline');setTimeout(()=>{failure('rpc_deadline');process.exit(2)},r.timeoutMs).unref();
const parseStat=PARSE_STAT,runRoot=RUN_ROOT;
const codes=RPC_CODES;let failed=false;const phase=RPC_PHASES.includes(r.op)?r.op:'install';
function failure(code){if(failed)return;failed=true;process.exitCode=2;process.stdout.write(JSON.stringify({ok:false,diagnostic:{phase,code:codes.includes(code)?code:'remote_unknown'}})+'\n')}
function admitted(c){const st=fs.lstatSync(c.sentinel.path);if(!st.isFile()||st.isSymbolicLink()||st.size>16384||fs.realpathSync(c.sentinel.path)!==c.sentinel.path)throw Error('sentinel_type');const s=JSON.parse(fs.readFileSync(c.sentinel.path,'utf8'));if(s.version!==1||s.provider!=='daytona'||s.token!==c.sentinel.token||s.companyId!==c.binding.companyId||s.environmentId!==c.binding.environmentId)throw Error('sentinel');if(fs.realpathSync(c.binding.remoteCwd)!==c.binding.remoteCwd)throw Error('cwd')}
function runtime(c){const root=c.binding.remoteCwd+'/'+c.runtimeRelative,boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();let s;try{s=fs.lstatSync(root,{bigint:true})}catch(e){if(e.code==='ENOENT')return {ready:false};throw e}if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('runtime_root_identity');const matches=[];const entries=fs.readdirSync('/proc');if(entries.length>8192)throw Error('proc_bound');for(const name of entries){if(!/^\d+$/.test(name)||Number(name)<2)continue;try{const p=parseStat(Number(name),fs.readFileSync('/proc/'+name+'/stat','utf8'),boot),argv=fs.readFileSync('/proc/'+name+'/cmdline').toString().split('\0').filter(Boolean);if(runRoot(argv,c.binding.runId,p)){if(argv[0]!==root+'/bin/paperclip-runnerd'||hash(fs.readFileSync('/proc/'+name+'/exe'))!==c.runnerdSha256)throw Error('runtime_binary_identity');if(p.state!=='Z')matches.push({pid:p.pid,ppid:p.ppid,startTicks:p.startTicks,bootId:p.bootId})}}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}}if(matches.length>1)throw Error('ambiguous_run_root');return matches.length===1?{ready:true,binding:c.binding,root:matches[0],runtime:{dev:String(s.dev),ino:String(s.ino),runnerExecutableSha256:c.runnerdSha256}}:{ready:false}}
(async()=>{let controlRequest=r;if(hash(fs.readFileSync(process.execPath))!==r.nodeSha256)throw Error('node_identity');if(r.op==='runtime-ready'||r.op==='install'){const c=r.config;admitted(c);const current=runtime(c);if(r.op==='runtime-ready'){process.stdout.write(JSON.stringify({ok:true,result:current})+'\n');return}if(!current.ready)throw Error('runtime_not_ready');if(JSON.stringify(current)!==JSON.stringify(r.expectedRuntime))throw Error('runtime_identity_changed');fs.mkdirSync(c.root,{mode:0o700});fs.writeFileSync(c.root+'/observer.cjs',r.source,{flag:'wx',mode:0o400});c.observerTtlMs=Math.max(1,c.observerTtlMs-(Date.now()-startedAt));const child=cp.spawn(process.execPath,[c.root+'/observer.cjs',Buffer.from(JSON.stringify(c)).toString('base64')],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});child.unref();r.root=c.root;controlRequest={op:'snapshot',nonce:c.nonce};}
for(let i=0;!fs.existsSync(r.root+'/control.sock')&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,10));const socket=net.connect(r.root+'/control.sock');let output='';socket.setTimeout(Math.max(1,r.timeoutMs-(Date.now()-startedAt)));socket.on('timeout',()=>{socket.destroy();failure('socket_timeout')});socket.on('error',()=>{failure('socket_error')});socket.on('connect',()=>socket.write(JSON.stringify(controlRequest)+'\n'));socket.on('data',b=>{output+=b;if(Buffer.byteLength(output)>262144){socket.destroy();failure('output_bound')}});socket.on('end',()=>{if(!process.exitCode)process.stdout.write(output)});
})().catch(e=>{failure(typeof e?.message==='string'?e.message:'remote_unknown')});`;

function rpcSource() {
  return RPC.replace("RPC_CODES", () => JSON.stringify(RPC_CODES)).replace("RPC_PHASES", () => JSON.stringify(RPC_PHASES)).replace("PARSE_STAT", () => parseRemoteProcStat.toString()).replace("RUN_ROOT", () => isRemoteRunRoot.toString());
}

export interface RemoteNativeFixture {
  readonly binding: RemoteNativeBinding;
  readonly remoteCwd: string;
  readonly actionFile: string;
  readonly outsideTarget: string | null;
  /** Watchers and exact run-root identity are already armed at return from bind. */
  readonly baseline: RemoteNativeSnapshot;
  snapshot(label: string): Promise<RemoteNativeSnapshot>;
  injectOwnedRunLoss?(): Promise<unknown>;
  readFile(path: string): Promise<Buffer>;
  publishAction(path: string, text: string): Promise<void>;
  killOwnedCopilot(): Promise<Record<string, unknown>>;
  setupAttachedCommand(input: { marker: string; markerText: string; delayMs: number; waitForFinishAttempt?: boolean }): Promise<{ command: string; commandSha256: string }>;
  releaseAttachedCommand(): Promise<{ releasedAtMs: number }>;
  /** Consumes the host-held terminal receipt; never queries a deleted lease. */
  finish(): Promise<RemoteNativeSnapshot>;
  /** Only fixture-owned observer cleanup. Never deletes a sandbox or lease. */
  close(): Promise<void>;
}
export interface RemoteNativeFixtureOptions {
  api: RemoteFixtureApi;
  daytona: RemoteFixtureDaytona;
  sdkVersion: typeof REMOTE_FIXTURE_DAYTONA_SDK_VERSION;
  authority: RemoteNativeAuthority;
  nodeSha256: string;
  runnerdSha256: string;
  targets: string[];
  actionFile: string;
  /** Cell deadline; receipt collection stops 15s earlier for public teardown. */
  deadlineAt: number;
  crossRoot?: { initialText: string };
  retainTerminalDiagnostics?(diagnostics: Record<string, boolean | number | readonly string[]>): Promise<void>;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
function readSnapshot(value: unknown, binding: RemoteNativeBinding, names: string[], actionFile: string, runnerdSha256: string): RemoteNativeSnapshot {
  const row = record(value), watcher = record(row.watcher), processes = record(row.processes), setup = record(row.setup);
  fail(JSON.stringify(row.binding) === JSON.stringify(binding), "receipt_binding");
  fail(Number.isSafeInteger(row.observedAtMs) && (row.observedAtMs as number) > 0 && typeof row.observedMonotonicNs === "string" && /^\d+$/u.test(row.observedMonotonicNs) && typeof row.complete === "boolean", "receipt_shape");
  fail(row.incompleteReasons === undefined || (Array.isArray(row.incompleteReasons) && row.incompleteReasons.length <= INCOMPLETE_REASONS.length && row.incompleteReasons.every(reason => INCOMPLETE_REASONS.includes(reason as typeof INCOMPLETE_REASONS[number])) && new Set(row.incompleteReasons).size === row.incompleteReasons.length), "incomplete_reason_shape");
  fail(Object.keys(record(row.workspace)).length <= 512 && Object.entries(record(row.workspace)).every(([path, hash]) => {
    try { relative(path); return hash === "directory" || sha(hash); } catch { return false; }
  }), "workspace_shape");
  fail(Object.keys(record(row.targets)).sort().join("\0") === [...names].sort().join("\0"), "target_set");
  for (const target of Object.values(record(row.targets))) {
    const t = record(target), parent = record(t.parent);
    fail(typeof t.absent === "boolean" && (t.absent ? t.sha256 === null : sha(t.sha256)) && typeof t.complete === "boolean"
      && Number.isSafeInteger(t.mutationCount) && (t.mutationCount as number) >= 0
      && /^\d+$/u.test(String(parent.dev)) && /^\d+$/u.test(String(parent.ino)), "target_shape");
  }
  fail(typeof watcher.complete === "boolean" && [watcher.targetMutationCount, watcher.workspaceMutationCount].every(n => Number.isSafeInteger(n) && (n as number) >= 0), "watcher_shape");
  const validProcess = (p: unknown) => {
    const i = record(p); return Number.isSafeInteger(i.pid) && (i.pid as number) >= 2 && Number.isSafeInteger(i.ppid) && (i.ppid as number) >= 0
      && typeof i.startTicks === "string" && /^\d+$/u.test(i.startTicks) && typeof i.bootId === "string" && /^[a-f0-9-]{36}$/u.test(i.bootId);
  };
  fail(typeof processes.captured === "boolean" && (processes.captured ? validProcess(processes.root) : processes.root === null)
    && Array.isArray(processes.journal) && processes.journal.length <= 512 && processes.journal.every(validProcess)
    && Array.isArray(processes.live) && processes.live.length <= 512
    && processes.live.every(pid => (processes.journal as unknown[]).some((p: unknown) => record(p).pid === pid)), "process_shape");
  const scope = record(row.scope), excluded = record(scope.excludedRuntime);
  fail(scope.kind === "user_workspace" && excluded.relativePath === RUNTIME_RELATIVE && excluded.absolutePath === `${binding.remoteCwd}/${RUNTIME_RELATIVE}`
    && /^\d+$/u.test(String(excluded.dev)) && /^\d+$/u.test(String(excluded.ino)) && excluded.runnerExecutableSha256 === runnerdSha256
    && typeof scope.observedPrpEnvironmentLeaseId === "string" && /^[-a-zA-Z0-9._:]{1,256}$/u.test(scope.observedPrpEnvironmentLeaseId)
    && scope.prpEnvironmentLeaseIdVerified === false, "evidence_scope");
  fail(setup.path === actionFile && typeof setup.published === "boolean" && (setup.published ? sha(setup.sha256) : setup.sha256 === null), "setup_shape");
  if (row.attached !== null) {
    const a = record(row.attached), exit = record(a.commandExit);
    fail(Number.isSafeInteger(a.connections) && (a.connections as number) >= 0 && (a.failure === null || ["client_bound", "child_start", "child_failed", "marker_failed", "client_rejected"].includes(String(a.failure)))
      && (a.commandExit === null || (Number.isSafeInteger(exit.code) && Number.isSafeInteger(exit.observedAtMs) && typeof exit.observedMonotonicNs === "string" && /^\d+$/u.test(exit.observedMonotonicNs)))
      && [a.markerWrittenAtMs, a.clientExitedAtMs].every(n => n === null || Number.isSafeInteger(n))
      && [a.markerWrittenMonotonicNs, a.clientExitedMonotonicNs].every(n => n === null || typeof n === "string" && /^\d+$/u.test(n)), "attached_shape");
  }
  const { files: _files, ...publicReceipt } = row;
  return { ...publicReceipt, receivedAtMs: Date.now() } as unknown as RemoteNativeSnapshot;
}

/** Must be called while the initial native input-file bootstrap holds the run.
 * No effect-producing task is published until baseline proves watcher + PID
 * admission. The exact controller runtime subtree is excluded only after its
 * directory inode/realpath, pinned executable and run/state-dir binding agree.
 * The PRP environment ID can be a durable workspace identity, not the sandbox
 * database lease ID; it is retained as observed, explicitly unverified metadata.
 * Same-UID observer opacity is not an OS adversarial sandbox. */
export async function bindRemoteNativeFixture(options: RemoteNativeFixtureOptions): Promise<RemoteNativeFixture> {
  const { authority, api, daytona } = options;
  // This reserve is never borrowed by normal RPCs or finish(). Only observer
  // close has an independent 10s cleanup grace; public lease teardown is caller-owned.
  const receiptDeadlineAt = options.deadlineAt - TEARDOWN_RESERVE_MS;
  fail(options.sdkVersion === REMOTE_FIXTURE_DAYTONA_SDK_VERSION, "sdk_pin");
  fail(Object.entries(authority).every(([key, value]) => key === "image" ? typeof value === "string" && /^[^\s]+@sha256:[a-f0-9]{64}$/u.test(value) : typeof value === "string" && id(value)), "authority_shape");
  fail(sha(options.nodeSha256) && sha(options.runnerdSha256), "binary_pins");
  fail(Number.isFinite(options.deadlineAt) && options.deadlineAt - Date.now() >= REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS, "insufficient_setup_budget");
  fail(options.targets.length <= 8 && new Set(options.targets).size === options.targets.length, "target_bound");
  const targets = options.targets.map(relative), actionFile = relative(options.actionFile);
  fail(!targets.includes(actionFile), "setup_target_overlap");
  fail([...targets, actionFile].every(path => path !== RUNTIME_RELATIVE && !path.startsWith(`${RUNTIME_RELATIVE}/`)), "runtime_target_forbidden");
  fail(!options.crossRoot || Buffer.byteLength(options.crossRoot.initialText) <= 4096, "cross_root_bound");
  const root = `/tmp/pc-native-${randomBytes(18).toString("hex")}`, nonce = randomBytes(32).toString("hex");
  let binding: RemoteNativeBinding | undefined, sentinel: { path: string; token: string } | undefined, identityKey: string | undefined;
  async function admittedSandbox() {
    const list = await api.get<unknown>(`/api/environments/${authority.environmentId}/leases`);
    const row = record(await api.get<unknown>(`/api/environment-leases/${authority.leaseId}`));
    fail(Array.isArray(list) && list.filter(item => record(item).id === authority.leaseId).length === 1, "lease_list");
    function admitted(row: Record<string, unknown>) {
      const metadata = record(row.metadata), sent = record(metadata.workspaceSentinel), cwd = metadata.remoteCwd;
      fail(row.id === authority.leaseId && row.companyId === authority.companyId && row.environmentId === authority.environmentId
        && row.heartbeatRunId === authority.runId && row.provider === "daytona" && row.providerLeaseId === authority.sandboxId
        && row.status === "active" && row.releasedAt == null, "lease_scope");
      fail(metadata.sandboxId === authority.sandboxId && metadata.image === authority.image && metadata.reuseLease === false, "lease_metadata");
      fail(typeof cwd === "string" && cwd.startsWith("/") && cwd.length < 512 && posix.normalize(cwd) === cwd && cwd !== "/" && !cwd.includes("\0"), "remote_cwd");
      fail(sent.path === `${cwd}/.paperclip-runtime/reusable-sandbox-lease.json` && sent.result === "written" && typeof sent.token === "string"
        && sent.token.length >= 16 && sent.token.length <= 256 && sent.runId === authority.runId && sent.providerLeaseId === authority.sandboxId, "sentinel_binding");
      return { binding: { ...authority, remoteCwd: cwd as string }, sentinel: { path: sent.path as string, token: sent.token as string } };
    }
    const current = admitted(row), listed = admitted(record((list as unknown[]).find(item => record(item).id === authority.leaseId)));
    const key = JSON.stringify(current);
    fail(JSON.stringify(listed) === key && (!identityKey || identityKey === key), "lease_identity_drift");
    const sandbox = await daytona.get(authority.sandboxId);
    fail(sandbox.id === authority.sandboxId && sandbox.labels?.["paperclip-provider"] === "daytona"
      && sandbox.labels?.["paperclip-company-id"] === authority.companyId && sandbox.labels?.["paperclip-environment-id"] === authority.environmentId
      && sandbox.labels?.["paperclip-run-id"] === authority.runId && sandbox.labels?.["paperclip-reuse-lease"] === "false", "sandbox_labels");
    binding = current.binding; sentinel = current.sentinel; identityKey = key;
    return sandbox;
  }
  async function bounded<T>(operation: () => Promise<T>, budgetMs: number): Promise<T> {
    fail(budgetMs >= 1, "receipt_deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("remote_native_fixture:remote_command_failed_or_deadline")), budgetMs);
          timer.unref();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function rpc(request: Record<string, unknown>, admitted?: Awaited<ReturnType<typeof admittedSandbox>>, deadlineAt = receiptDeadlineAt) {
    const available = request.op === "close" ? CLOSE_GRACE_MS : deadlineAt - Date.now();
    const cap = request.op === "install" ? INSTALL_BUDGET_MS : request.op === "wait" ? 300_000 : RUNTIME_READY_BUDGET_MS;
    const budgetMs = Math.floor(Math.min(available, cap) / 1000) * 1000;
    fail(budgetMs >= 1000, "receipt_deadline");
    if (request.op === "install") fail(budgetMs >= 25_000, "insufficient_setup_budget");
    const operationDeadline = Date.now() + budgetMs;
    return bounded(async () => {
      const sandbox = admitted ?? await admittedSandbox();
      const commandCap = request.op === "install" ? 25_000 : request.op === "wait" ? 300_000 : 10_000;
      const timeoutMs = Math.floor(Math.min(operationDeadline - Date.now(), commandCap) / 1000) * 1000;
      fail(timeoutMs >= 1000, "receipt_deadline");
      const config = request.op === "install"
        ? { ...record(request.config), observerTtlMs: Math.floor((receiptDeadlineAt - Date.now()) / 1000) * 1000 }
        : undefined;
      const payload = Buffer.from(JSON.stringify({ ...request, ...(config ? { config } : {}), root, nonce, nodeSha256: options.nodeSha256, timeoutMs })).toString("base64");
      const command = `/usr/bin/env -i PATH=/usr/bin:/bin ${quote(NODE)} -e ${quote(rpcSource())} ${quote(payload)}`;
      let response: { exitCode: number; result: string };
      try { response = await sandbox.process.executeCommand(command, binding!.remoteCwd, {}, timeoutMs / 1000); }
      catch { throw new RemoteFixtureError("remote_native_fixture:remote_command_failed_or_deadline", { phase: request.op as RpcPhase, code: "transport_failure" }); }
      if (typeof response.result !== "string" || Buffer.byteLength(response.result) > MAX_OUTPUT) throw new RemoteFixtureError("remote_native_fixture:command_failed_or_output_bound", { phase: request.op as RpcPhase, code: "output_bound" });
      if (response.exitCode !== 0) {
        let diagnostic: RpcDiagnostic = { phase: request.op as RpcPhase, code: "invalid_response" };
        try {
          const value = record(JSON.parse(response.result)), d = record(value.diagnostic);
          if (value.ok === false && Object.keys(value).sort().join() === "diagnostic,ok" && Object.keys(d).sort().join() === "code,phase"
            && d.phase === request.op && RPC_CODES.includes(d.code as RpcCode)) diagnostic = { phase: d.phase as RpcPhase, code: d.code as RpcCode };
        } catch { /* Never retain remote text. */ }
        throw new RemoteFixtureError(`remote_native_fixture:command_failed_or_output_bound:${diagnostic.phase}:${diagnostic.code}`, diagnostic);
      }
      let parsed: Record<string, unknown>;
      try { parsed = record(JSON.parse(response.result)); } catch { throw new Error("remote_native_fixture:invalid_observer_json"); }
      fail(parsed.ok === true, "observer_incomplete");
      return parsed.result;
    }, budgetMs);
  }
  const sandbox = await bounded(admittedSandbox, Math.min(LEASE_READMISSION_BUDGET_MS, receiptDeadlineAt - Date.now()));
  const names = [...targets, ...(options.crossRoot ? ["@cross-root"] : [])];
  const config = { root, nonce, binding, sentinel, targets, actionFile, crossRoot: options.crossRoot, runtimeRelative: RUNTIME_RELATIVE, runnerdSha256: options.runnerdSha256 };
  // Lease activation precedes runner artifact staging. Observe the exact pinned
  // run root before spending the single installation budget. No observer or
  // action exists during this polling phase, and failures are never retried.
  const readyDeadline = receiptDeadlineAt - INSTALL_BUDGET_MS;
  let expectedRuntime: Record<string, unknown>;
  while (true) {
    if (readyDeadline - Date.now() < 1000) throw new RemoteFixtureError("remote_native_fixture:readiness_deadline", { phase: "runtime-ready", code: "readiness_deadline" });
    const value = record(await rpc({ op: "runtime-ready", config }, undefined, readyDeadline));
    if (value.ready === true) {
      const process = record(value.root), runtime = record(value.runtime);
      fail(Object.keys(value).sort().join() === "binding,ready,root,runtime" && JSON.stringify(value.binding) === JSON.stringify(binding)
        && Object.keys(process).sort().join() === "bootId,pid,ppid,startTicks" && Number.isSafeInteger(process.pid) && Number(process.pid) > 1
        && Number.isSafeInteger(process.ppid) && Number(process.ppid) >= 0 && typeof process.startTicks === "string" && /^\d+$/u.test(process.startTicks)
        && typeof process.bootId === "string" && /^[a-f0-9-]{36}$/u.test(process.bootId)
        && Object.keys(runtime).sort().join() === "dev,ino,runnerExecutableSha256" && typeof runtime.dev === "string" && /^\d+$/u.test(runtime.dev)
        && typeof runtime.ino === "string" && /^\d+$/u.test(runtime.ino) && runtime.runnerExecutableSha256 === options.runnerdSha256, "runtime_ready_identity");
      expectedRuntime = value; break;
    }
    fail(value.ready === false && Object.keys(value).length === 1, "runtime_ready_shape");
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, readyDeadline - Date.now()))));
  }
  let baseline: RemoteNativeSnapshot;
  try {
    baseline = readSnapshot(await rpc({ op: "install", config, expectedRuntime, source: observerSource() }), binding!, names, actionFile, options.runnerdSha256);
    fail(baseline.complete && baseline.processes.captured && baseline.processes.live.length > 0 && baseline.watcher.complete && !baseline.setup.published, "bootstrap_not_held");
    fail((["pid", "ppid", "startTicks", "bootId"] as const).every(key => baseline.processes.root?.[key] === record(expectedRuntime.root)[key])
      && baseline.scope.excludedRuntime.dev === record(expectedRuntime.runtime).dev && baseline.scope.excludedRuntime.ino === record(expectedRuntime.runtime).ino, "runtime_identity_changed");
  } catch (error) {
    // Only the nonce/inode-bound observer can acknowledge this cleanup. If
    // launch failed before its socket became available, TTL remains a bound,
    // not a claimed successful cleanup receipt.
    try { await rpc({ op: "close" }, sandbox); }
    catch (cleanupError) { throw new RemoteFixtureError("remote_native_fixture:startup_failed_cleanup_unproven", remoteNativeFixtureDiagnostics(cleanupError)[0] ?? { phase: "close", code: "remote_unknown" }, { cause: error }); }
    throw error;
  }
  // Start receiving while the lease is still authorized, before publishAction.
  // Rejection is retained (no unhandled rejection); finish reports it unchanged.
  let stopReceipt!: () => void;
  const cancelledReceipt = new Promise<never>((_resolve, reject) => { stopReceipt = () => reject(new Error("remote_native_fixture:closed_before_receipt")); });
  const terminal = Promise.race([rpc({ op: "wait" }, sandbox), cancelledReceipt])
    .then(value => ({ value, receivedAtMs: Date.now() }), error => ({ error }));
  try {
    const armed = record(await rpc({ op: "arm" }, sandbox));
    fail(armed.armed === true && armed.sealed === false, "receipt_channel_not_armed");
  } catch (error) {
    try { await rpc({ op: "close" }, sandbox); }
    catch { throw new Error("remote_native_fixture:receipt_channel_failed_cleanup_unproven", { cause: error }); }
    stopReceipt();
    throw error;
  }
  let closed = false, published = false, finished: RemoteNativeSnapshot | undefined;
  const retainedFiles = new Map<string, Buffer>();
  return {
    binding: binding!, remoteCwd: binding!.remoteCwd, actionFile, outsideTarget: options.crossRoot ? `${root}/cross-root-target` : null, baseline,
    async snapshot(label) {
      fail(typeof label === "string" && /^[a-zA-Z0-9_-]{1,80}$/u.test(label), "snapshot_label");
      fail(!closed && !finished, "fixture_closed");
      return readSnapshot(await rpc({ op: "snapshot" }), binding!, names, actionFile, options.runnerdSha256);
    },
    async readFile(path) {
      fail(!closed && names.includes(path), "unregistered_read");
      if (finished) { const bytes = retainedFiles.get(path); fail(bytes, "terminal_file_missing"); return Buffer.from(bytes!); }
      const data = record(await rpc({ op: "read", path }));
      fail(typeof data.base64 === "string" && data.base64.length <= 87384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data.base64), "read_bound");
      const bytes = Buffer.from(data.base64 as string, "base64");
      fail(bytes.length <= 65536 && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === data.sha256, "read_digest");
      return bytes;
    },
    async injectOwnedRunLoss() {
      fail(!closed && published && !finished, "loss_fixture_unavailable");
      const value = record(await rpc({ op: "inject-loss" }));
      const observed = record(value.root), root = baseline.processes.root;
      fail(root && observed.pid === root.pid && observed.startTicks === root.startTicks && observed.bootId === root.bootId
        && value.signal === "SIGKILL" && typeof value.observedMonotonicNs === "string" && /^\d+$/u.test(value.observedMonotonicNs), "loss_owner_acknowledgement");
      return value;
    },
    async publishAction(path, text) {
      fail(!closed && !published && path === actionFile && typeof text === "string" && Buffer.byteLength(text) <= 16384, "publish_bound");
      // Set before RPC: uncertain delivery must never cause a second publish.
      published = true;
      const ack = record(await rpc({ op: "publish", path, text }));
      fail(ack.published === true && ack.path === path && ack.sha256 === digest(text), "publish_ack");
    },
    async killOwnedCopilot() {
      fail(!closed && published && !finished, "death_boundary");
      const result = record(await rpc({ op: "provider-death" }));
      fail(result.schema === "paperclip.e2e.copilot-owned-provider-death.v1" && result.signal === "SIGKILL" && /^sha256:[a-f0-9]{64}$/u.test(String(result.commandSha256)) && /^\d+$/u.test(String(result.dispatchedMonotonicNs)), "death_ack");
      return result;
    },
    async setupAttachedCommand(input) {
      fail(!closed && !published && targets.includes(input.marker) && Number.isInteger(input.delayMs) && input.delayMs >= 100 && input.delayMs <= 8000
        && typeof input.markerText === "string" && Buffer.byteLength(input.markerText) <= 4096, "attached_bound");
      const clientNonce = randomBytes(24).toString("hex");
      const result = record(await rpc({ op: "attached", ...input, clientNonce }));
      fail(result.clientScript === `${root}/client.cjs` && result.clientSocket === `${root}/attached.sock`, "attached_identity");
      const command = `${quote(NODE)} ${quote(result.clientScript as string)} ${quote(result.clientSocket as string)} ${quote(clientNonce)}`;
      return { command, commandSha256: digest(command) };
    },
    async releaseAttachedCommand() {
      fail(!closed && published && !finished, "attached_release_boundary");
      const result = record(await rpc({ op: "release-attached" }));
      fail(Number.isSafeInteger(result.releasedAtMs) && (result.releasedAtMs as number) >= 0, "attached_release_ack");
      return { releasedAtMs: result.releasedAtMs as number };
    },
    async finish() {
      if (finished) return finished;
      const receipt = await terminal;
      if ("error" in receipt) throw receipt.error;
      fail(receipt.receivedAtMs <= receiptDeadlineAt, "receipt_deadline");
      const result = readSnapshot(receipt.value, binding!, names, actionFile, options.runnerdSha256);
      const allowed = new Set<string>(TERMINAL_FAILURE_CODES);
      const reasons = record(receipt.value).failureCodes;
      const codes = Array.isArray(reasons) ? [...new Set(reasons.filter((code): code is string => typeof code === "string" && allowed.has(code)))].slice(0, allowed.size) : [];
      await options.retainTerminalDiagnostics?.({ failureCodes: codes, actionPublished: published, setupPublished: result.setup.published, complete: result.complete, watcherComplete: result.watcher.complete, targetMutationCount: result.watcher.targetMutationCount, workspaceMutationCount: result.watcher.workspaceMutationCount, processRootCaptured: result.processes.captured, liveProcessCount: result.processes.live.length, incompleteReasons: result.incompleteReasons ?? [] });
      if (!(published && result.setup.published && result.complete && result.watcher.complete && result.processes.captured && result.processes.live.length === 0)) {
        // Closed flags explain missing evidence without retaining SDK output,
        // provider text, file contents or opaque observer control credentials.
        const flags = [`published=${published && result.setup.published}`, `complete=${result.complete}`, `watcher=${result.watcher.complete}`, `captured=${result.processes.captured}`, `live=${result.processes.live.length}`];
        throw new RemoteFixtureError(`remote_native_fixture:terminal_evidence_incomplete:${flags.join(",")}:${codes.join(",")}`, { phase: "wait", code: "terminal_evidence_incomplete" });
      }
      const files = record(record(receipt.value).files);
      for (const name of names) {
        const target = result.targets[name]!;
        if (target.absent) { fail(files[name] === undefined, "terminal_file_presence"); continue; }
        fail(typeof files[name] === "string" && (files[name] as string).length <= 87384, "terminal_file_bound");
        const bytes = Buffer.from(files[name] as string, "base64");
        fail(bytes.length <= 65536 && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === target.sha256, "terminal_file_digest");
        retainedFiles.set(name, bytes);
      }
      result.receivedAtMs = receipt.receivedAtMs;
      finished = result; return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      // A finalized receipt survives ordinary public lease deletion. If the
      // lease still exists, clean our opaque observer; never discover by name.
      if (!finished) { stopReceipt(); await rpc({ op: "close" }); }
    },
  };
}
