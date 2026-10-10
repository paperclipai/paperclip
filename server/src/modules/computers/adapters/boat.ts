import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createSshCommandManagedRuntimeRunner,
  shellQuote,
} from "@paperclipai/adapter-utils/ssh";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { ComputerBackend } from "../application/ports.js";
import {
  ComputerError,
  segment,
  type ComputerRecord,
  type Owner,
} from "../domain/ledger.js";
import { remoteProgram } from "./remote-program.js";

const apiOrigin = "https://boat.dev/api/v1";
const transportCache = new Map<string, Promise<CommandManagedRuntimeRunner>>();
type CommandInput = Parameters<CommandManagedRuntimeRunner["execute"]>[0];

/** Reserve SSH admission for lifecycle/identity calls while bulk and legacy commands run. */
export function createBoatTransportAdmission() {
  let active = 0;
  let ordinary = 0;
  let bulk = 0;
  const queue: Array<{ control: boolean; bulk: boolean; start: () => void }> = [];
  function drain() {
    while (active < 8) {
      const eligible = (entry: (typeof queue)[number]) =>
        entry.control || (ordinary < 6 && (!entry.bulk || bulk < 4));
      let index = queue.findIndex((entry) => entry.control && eligible(entry));
      if (index < 0) index = queue.findIndex(eligible);
      if (index < 0) break;
      queue.splice(index, 1)[0]!.start();
    }
  }
  return async function execute(
    runner: CommandManagedRuntimeRunner,
    input: CommandInput,
    control: boolean,
  ) {
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + (input.timeoutMs ?? 15_000);
    const isBulk = Buffer.byteLength(input.stdin ?? "") > 1024 * 1024;
    // Even process-control callers must use the ordinary budget for large uploads.
    const isControl = control && !isBulk;
    if (queue.length >= 128)
      throw new ComputerError("conflict", "Computer command admission is busy");
    return new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve, reject) => {
      const timedOut = () => resolve({ exitCode: null, signal: null, timedOut: true,
        stdout: "", stderr: "Computer command timed out waiting for SSH admission", pid: null, startedAt });
      const entry = { control: isControl, bulk: isBulk, start: () => {
        clearTimeout(timer);
        const remaining = deadline - Date.now();
        if (remaining <= 0) { timedOut(); return; }
        active++;
        if (!isControl) ordinary++;
        if (isBulk) bulk++;
        void Promise.resolve().then(() => runner.execute({ ...input, timeoutMs: remaining }))
          .then(resolve, reject).finally(() => {
            active--;
            if (!isControl) ordinary--;
            if (isBulk) bulk--;
            drain();
          });
      } };
      const timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        timedOut();
        drain();
      }, Math.max(1, deadline - Date.now()));
      queue.push(entry);
      drain();
    });
  };
}
const transportAdmission = new Map<string, ReturnType<typeof createBoatTransportAdmission>>();
const desktopCache = new Map<
  string,
  { viewerUrl: string; expiresAt: string }
>();
export const desktopReadinessProgram = String.raw`
import os,sys,json,stat,fcntl,subprocess,time
# Boat restores its persistent home, but Unix sockets there can refer to stale
# kernel listeners. Keep a healthy IBus unchanged; repair only a failed probe.
uid=os.getuid();runtime='/run/user/'+str(uid)
st=os.lstat(runtime)
if not stat.S_ISDIR(st.st_mode) or st.st_uid!=uid:raise RuntimeError('invalid desktop runtime directory')
env={**os.environ,'HOME':'/home/user','XDG_CONFIG_HOME':'/home/user/.config','XDG_CACHE_HOME':'/home/user/.cache','DISPLAY':':0','XAUTHORITY':'/home/user/.Xauthority','DBUS_SESSION_BUS_ADDRESS':'unix:path='+runtime+'/bus','XDG_RUNTIME_DIR':runtime,'IBUS_ENABLE_SYNC_MODE':'0'}
env.pop('IBUS_ADDRESS',None)
def healthy():
 try:
  address=subprocess.run(['ibus','address'],env=env,capture_output=True,text=True,timeout=5)
  if address.returncode or not address.stdout.strip().startswith('unix:'):return False
  return subprocess.run(['gdbus','call','--address',address.stdout.strip(),'--dest','org.freedesktop.IBus','--object-path','/org/freedesktop/IBus','--method','org.freedesktop.DBus.Peer.Ping'],env=env,capture_output=True,timeout=5).returncode==0
 except subprocess.TimeoutExpired:return False
root=runtime+'/paperclip-ibus'
os.makedirs(root,mode=0o700,exist_ok=True)
st=os.lstat(root)
if not stat.S_ISDIR(st.st_mode) or st.st_uid!=uid:raise RuntimeError('invalid desktop input directory')
os.chmod(root,0o700)
fd=os.open(root+'/lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if not healthy():
  result=subprocess.run(['ibus-daemon','--replace','--daemonize','--xim','--address','unix:path='+root+'/bus'],env=env,capture_output=True,timeout=20)
  if result.returncode:raise RuntimeError('desktop input repair failed')
  for attempt in range(10):
   if healthy():break
   time.sleep(0.2)
  else:raise RuntimeError('desktop input did not become ready')
`;

export const processProgram = String.raw`
import os,sys,json,fcntl,subprocess,shutil,re,datetime
p=json.load(sys.stdin);base='/home/user/.paperclip-owners';os.makedirs(base,exist_ok=True)
def retire_owner(root,oid):
 open(os.path.join(root,'retired'),'a').close()
 unit='paperclip-'+oid+'.service';slice='paperclip-'+oid+'.slice'
 subprocess.run(['systemctl','--user','stop',slice,unit],capture_output=True)
 state=subprocess.run(['systemctl','--user','show',slice,'--property=ActiveState','--value'],capture_output=True,text=True).stdout.strip()
 if state not in ('inactive','failed',''):raise RuntimeError('process retirement unconfirmed')
 for entry in os.scandir(root):
  if entry.name.startswith('command-') and entry.is_dir(follow_symlinks=False):
   try:shutil.rmtree(entry.path)
   except FileNotFoundError:pass
if p['action']=='cleanup-retired':
 # The controller supplies only its durable retired runner identities. Do not
 # discover owners from the filesystem or touch any agent/project directory.
 for owner in p['owners']:
  oid=owner['id']
  if not isinstance(oid,str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}',oid):raise RuntimeError('invalid retired owner')
  root=os.path.join(base,oid)
  if os.path.islink(root):raise RuntimeError('invalid retired owner directory')
  if not os.path.isdir(root):continue
  with open(os.path.join(root,'lock'),'a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   generation_path=os.path.join(root,'generation')
   generation=int(open(generation_path).read()) if os.path.exists(generation_path) else 0
   if owner['generation']<generation:print(json.dumps({'error':'conflict'}));sys.exit(0)
   if os.path.exists(os.path.join(root,'retired')) and not any(e.name.startswith('command-') and e.is_dir(follow_symlinks=False) for e in os.scandir(root)):continue
   retire_owner(root,oid)
 print('{}');sys.exit(0)
owner=p['owner'];oid=owner['id'];root=os.path.join(base,oid);os.makedirs(root,exist_ok=True)
with open(os.path.join(root,'lock'),'a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 tombstone=os.path.join(root,'retired');unit='paperclip-'+oid+'.service';slice='paperclip-'+oid+'.slice'
 boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 generation_path=os.path.join(root,'generation')
 generation=int(open(generation_path).read()) if os.path.exists(generation_path) else 0
 if owner['generation']<generation:print(json.dumps({'error':'conflict'}));sys.exit(0)
 if p['action']=='advance':
  if os.path.exists(tombstone):print(json.dumps({'error':'conflict'}));sys.exit(0)
  retirement=os.path.join(root,'retiring.json')
  if owner.get('phase')=='retiring':
   deadline=datetime.datetime.fromisoformat(owner['retirementDeadline'].replace('Z','+00:00')).timestamp()*1000
   with open(retirement,'w') as f:json.dump({'deadline':deadline},f)
  elif os.path.exists(retirement):print(json.dumps({'error':'conflict'}));sys.exit(0)
  with open(generation_path,'w') as f:f.write(str(owner['generation']))
  print('{}')
 elif p['action']=='retire':
  retire_owner(root,oid)
  print('{}')
 elif p['action']=='inspect':
  claim=owner.get('process');marker=os.path.join(root,'claim.json');actual=json.load(open(marker)) if os.path.exists(marker) else None
  valid=claim and actual and claim['nonce']==actual['nonce'] and claim['launchGeneration']==actual['launchGeneration'] and actual['bootId']==boot
  state=subprocess.run(['systemctl','--user','is-active',unit],capture_output=True,text=True).stdout.strip()
  print(json.dumps({'running':bool(valid and state=='active' and not os.path.exists(tombstone)),'claim':actual if valid else claim}))
 else:
  if os.path.exists(tombstone) or os.path.exists(os.path.join(root,'retiring.json')):print(json.dumps({'error':'conflict'}));sys.exit(0)
  claim=owner['process'];claim['bootId']=boot
  marker=os.path.join(root,'claim.json')
  if os.path.exists(marker):
   old=json.load(open(marker))
   if old['launchGeneration']>claim['launchGeneration'] or (old['launchGeneration']==claim['launchGeneration'] and old['nonce']!=claim['nonce']):print(json.dumps({'error':'conflict'}));sys.exit(0)
   active=subprocess.run(['systemctl','--user','is-active',unit],capture_output=True,text=True).stdout.strip()=='active'
   if active and old['nonce']!=claim['nonce']:print(json.dumps({'error':'conflict'}));sys.exit(0)
  with open(marker,'w') as f:json.dump(claim,f)
  # Shell launch scripts own expansion of their positional arguments and identity markers.
  payload=p['input'];args=['systemd-run','--user','--expand-environment=no','--unit='+unit,'--slice='+slice,'--collect','--property=KillMode=control-group','--working-directory='+payload.get('cwd','/home/user')]
  for key,value in payload.get('env',{}).items():args.append('--setenv='+key+'='+value)
  state=subprocess.run(['systemctl','--user','is-active',unit],capture_output=True,text=True).stdout.strip()
  if state!='active':
   result=subprocess.run(args+['--',payload['command']]+payload.get('args',[]),capture_output=True)
   if result.returncode:raise RuntimeError('launch failed')
  print(json.dumps(claim))
`;
export function boatBackend(
  resolveKey: (record: ComputerRecord) => Promise<string>,
  fetcher: typeof fetch = fetch,
): ComputerBackend {
  async function api(
    record: ComputerRecord,
    method: string,
    suffix = "",
    body?: unknown,
  ): Promise<any> {
    const response = await fetcher(
      `${apiOrigin}/sandboxes/${segment(record.providerId)}${suffix}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await resolveKey(record)}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok)
      throw new ComputerError(
        "provider_error",
        `Boat request failed (${response.status})`,
      );
    const data = await response.json();
    if (!data || typeof data !== "object")
      throw new ComputerError("provider_error", "Invalid Boat response");
    return data;
  }
  async function inspect(record: ComputerRecord) {
    const data = await api(record, "GET");
    const sandbox = data.sandbox ?? data;
    if (sandbox.id !== record.providerId || typeof sandbox.state !== "string")
      throw new ComputerError(
        "provider_error",
        "Boat returned a different computer",
      );
    return {
      state: sandbox.state as string,
      snapshots: sandbox.snapshots === true,
      stop: sandbox.stop ?? null,
    };
  }
  async function rawRunner(
    record: ComputerRecord,
  ): Promise<CommandManagedRuntimeRunner> {
    const key = `${record.id}:${record.ledger.secretRef.secretId}:${record.ledger.secretRef.version ?? "latest"}`;
    let pending = transportCache.get(key);
    if (!pending) {
      pending = (async () => {
        const pair = generateKeyPairSync("ed25519");
        const jwk = pair.publicKey.export({ format: "jwk" });
        const publicBytes = Buffer.from(jwk.x!, "base64url");
        const name = Buffer.from("ssh-ed25519");
        const length = (n: number) => {
          const b = Buffer.alloc(4);
          b.writeUInt32BE(n);
          return b;
        };
        const publicKey = `ssh-ed25519 ${Buffer.concat([length(name.length), name, length(publicBytes.length), publicBytes]).toString("base64")} paperclip-computer`;
        // OpenSSH cannot read PKCS8 Ed25519 keys; emit its unencrypted private format in memory.
        const seed = Buffer.from(
          pair.privateKey.export({ format: "jwk" }).d!,
          "base64url",
        );
        const field = (b: Buffer) => Buffer.concat([length(b.length), b]);
        const check = Buffer.from("70617065", "hex");
        let privateBody = Buffer.concat([
          check,
          check,
          field(name),
          field(publicBytes),
          field(Buffer.concat([seed, publicBytes])),
          field(Buffer.from("paperclip-computer")),
        ]);
        const padding = 8 - (privateBody.length % 8);
        privateBody = Buffer.concat([
          privateBody,
          Buffer.from(Array.from({ length: padding }, (_, i) => i + 1)),
        ]);
        const publicBlob = Buffer.concat([field(name), field(publicBytes)]);
        const blob = Buffer.concat([
          Buffer.from("openssh-key-v1\0"),
          field(Buffer.from("none")),
          field(Buffer.from("none")),
          field(Buffer.alloc(0)),
          length(1),
          field(publicBlob),
          field(privateBody),
        ]);
        const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob
          .toString("base64")
          .match(/.{1,70}/g)!
          .join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
        const result = await api(record, "POST", "/sshkey", { key: publicKey });
        if (
          typeof result.hostKey !== "string" ||
          !/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(result.hostKey.trim())
        )
          throw new ComputerError(
            "provider_error",
            "Boat did not provide a valid SSH host key",
          );
        const endpoint =
          typeof result.sshEndpoint === "string" ? result.sshEndpoint : null;
        const parsed = endpoint?.match(/^([A-Za-z0-9.-]+):(\d+)$/);
        const host = parsed?.[1] ?? result.machineIp;
        const port = parsed ? Number(parsed[2]) : 22;
        if (
          typeof host !== "string" ||
          !host ||
          /[\s/]/.test(host) ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        )
          throw new ComputerError(
            "provider_error",
            "Invalid Boat SSH endpoint",
          );
        const knownHost = port === 22 ? host : `[${host}]:${port}`;
        return createSshCommandManagedRuntimeRunner({
          spec: {
            host,
            port,
            username: "user",
            remoteWorkspacePath: "/home/user",
            remoteCwd: "/home/user",
            privateKey,
            knownHosts: `${knownHost} ${result.hostKey.trim()}\n`,
            strictHostKeyChecking: true,
          },
          maxBufferBytes: 24 * 1024 * 1024,
        });
      })();
      transportCache.set(key, pending);
      pending.catch(() => transportCache.delete(key));
    }
    return pending;
  }
  async function runner(record: ComputerRecord, options?: { control?: boolean }): Promise<CommandManagedRuntimeRunner> {
    const raw = await rawRunner(record);
    let admission = transportAdmission.get(record.providerId);
    if (!admission) {
      admission = createBoatTransportAdmission();
      transportAdmission.set(record.providerId, admission);
    }
    const execute = admission;
    return { ...raw, execute: (input) => execute(raw, input, options?.control === true) };
  }
  async function execute(
    record: ComputerRecord,
    code: string,
    payload: unknown,
    control = true,
  ) {
    const result = await (
      await runner(record, { control })
    ).execute({
      command: "python3",
      args: ["-c", code],
      stdin: JSON.stringify(payload),
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0)
      throw new ComputerError("provider_error", "Computer operation failed");
    let value: any;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new ComputerError(
        "provider_error",
        "Invalid computer operation response",
      );
    }
    if (value?.error)
      throw new ComputerError(
        ["not_found", "conflict", "invalid"].includes(value.error)
          ? value.error
          : "provider_error",
        `Computer operation: ${value.error}`,
      );
    return value;
  }

  async function host(record: ComputerRecord, port: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new ComputerError("invalid", "Invalid preview port");
    const result = await api(record, "POST", "/host", {
      port,
      access: "private",
    });
    const url = new URL(result.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".on.boat.dev") ||
      url.username ||
      url.password ||
      !url.searchParams.get("_token") ||
      result.access === "public"
    )
      throw new ComputerError(
        "provider_error",
        "Boat did not provide private hosting",
      );
    return url;
  }
  function stopReceipt(
    value: any,
    expectedId?: string,
  ): { id: string; status: string } {
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^stop_[a-zA-Z0-9]+$/.test(value.id) ||
      (expectedId && value.id !== expectedId) ||
      !["pending", "failing", "completed", "superseded"].includes(value.status)
    ) {
      throw new ComputerError(
        "provider_error",
        "Boat returned an invalid stop receipt",
      );
    }
    return { id: value.id, status: value.status };
  }
  return {
    inspect,
    runner,
    async ready(record) {
      const state = await inspect(record);
      if (!state.snapshots)
        throw new ComputerError("invalid", "Boat snapshots must be enabled");
      if (state.stop && ["pending", "failing"].includes(state.stop.status))
        throw new ComputerError(
          "conflict",
          "Boat is still saving a previous stop",
        );
      if (!["ready", "idle", "running"].includes(state.state)) {
        await api(record, "POST", "/resume", { ttlSeconds: 300 });
        transportCache.delete(
          `${record.id}:${record.ledger.secretRef.secretId}:${record.ledger.secretRef.version ?? "latest"}`,
        );
        for (let i = 0; i < 90; i++) {
          const status = await inspect(record);
          if (["ready", "idle", "running"].includes(status.state)) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new ComputerError("provider_error", "Boat did not become ready");
      }
    },
    async claim(record) {
      await execute(
        record,
        String.raw`
import os,sys,json,fcntl
p=json.load(sys.stdin);path='/home/user/.paperclip-controller.json'
fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX);old=f.read()
 if old and json.loads(old)!=p:print(json.dumps({'error':'conflict'}));sys.exit(0)
 if not old:f.write(json.dumps(p));f.flush();os.fsync(f.fileno())
print('{}')
`,
        {
          controllerId: record.ledger.controllerId,
          companyId: record.companyId,
          computerId: record.id,
        },
      );
      const retiredOwners = record.ledger.owners
        .filter((owner) => owner.kind === "runner" && owner.phase === "retired")
        .map(({ id, generation }) => ({ id, generation }));
      if (retiredOwners.length) {
        // Archived providers cannot clean remote files. Settle their exact
        // retired owners after resume, before admitting any new command.
        await execute(record, processProgram, {
          action: "cleanup-retired",
          owners: retiredOwners,
        });
      }
    },
    async advance(record, owner) {
      await execute(record, processProgram, { action: "advance", owner });
    },
    async launch(record, owner, input) {
      return execute(record, processProgram, {
        action: "launch",
        owner,
        input,
      });
    },
    async inspectProcess(record, owner) {
      return execute(record, processProgram, { action: "inspect", owner });
    },
    async retire(record, owner) {
      await execute(record, processProgram, { action: "retire", owner });
    },
    async stop(record) {
      const value = await api(record, "POST", "/stop", {});
      const stop = value.stop ?? value.sandbox?.stop;
      return stopReceipt(stop);
    },
    async stopStatus(record, id) {
      const value = await api(record, "GET", `/stops/${segment(id)}`);
      return stopReceipt(value.stop ?? value, id);
    },
    async renew(record) {
      await api(record, "PATCH", "", { ttlSeconds: 300 });
    },
    computerTool() {
      return {
        command: "python3",
        args: ["-c", `${desktopReadinessProgram}\nos.execv('/opt/ascii/cua-driver/cua-driver',['cua-driver','mcp','--socket','/run/ascii-cua/driver.sock'])`],
      };
    },
    async desktop(record) {
      await execute(record, `${desktopReadinessProgram}\nprint('{}')`, {});
      const cached = desktopCache.get(record.id);
      if (cached && Date.parse(cached.expiresAt) > Date.now() + 60_000)
        return cached;
      const value = await api(record, "POST", "/desktop", {});
      const url = new URL(value.desktopUrl);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".on.boat.dev"))
        throw new ComputerError("provider_error", "Invalid Boat desktop URL");
      url.searchParams.set("overlay", "0");
      const result = {
        viewerUrl: url.toString(),
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
      };
      desktopCache.set(record.id, result);
      return result;
    },
    async preview(record, port) {
      return { url: (await host(record, port)).toString() };
    },
    async ingress(record, port, path) {
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[?#\r\n]/.test(path)
      )
        throw new ComputerError("invalid", "Invalid runner ingress path");
      const url = await host(record, port);
      const response = await fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("_port_auth="))
        ?.split(";")[0];
      if (!cookie || response.status < 200 || response.status >= 400)
        throw new ComputerError(
          "provider_error",
          "Boat private hosting authentication failed",
        );
      url.search = "";
      url.hash = "";
      url.protocol = "wss:";
      url.pathname = path;
      return { url: url.toString(), secretHeaders: { Cookie: cookie } };
    },
    async remote(record, input) {
      // Git setup and file I/O may wait on locks or transfer substantial data.
      // Keep lifecycle capacity reserved; only the short owned-port probe uses it.
      return execute(record, remoteProgram, input, input.action === "owned-port");
    },
  };
}
