import { StringDecoder } from "node:string_decoder";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { definePlugin, decodeChannelBytes } from "@paperclipai/plugin-sdk";
import type {
  PluginContext, PluginEnvironmentAcquireLeaseParams, PluginEnvironmentDriverBaseParams,
  PluginEnvironmentLease, PluginEnvironmentResumeLeaseParams, PluginEnvironmentExecuteResult,
  PluginEnvironmentReleaseLeaseParams, PluginEnvironmentTerminationReceipt,
} from "@paperclipai/plugin-sdk";
import { openSsh, ssh, quote, type SshConfig } from "./transport.js";
import { validateSshPrivateKey } from "./ssh-key.js";
export { validateSshPrivateKey } from "./ssh-key.js";

const SUPERVISOR = "/opt/paperclip-exe/lease.mjs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
interface Config extends SshConfig {
  vmName?: string;
  mode: "create" | "attach";
  image?: string;
  registryAuth?: string;
  cpu: number;
  memory: string;
  disk: string;
}
export function parseConfig(raw: Record<string, unknown>): Config {
  const str = (key: string) => typeof raw[key] === "string" && String(raw[key]).trim() ? String(raw[key]).trim() : undefined;
  const mode = raw.mode ?? "attach";
  const config: Config = {
    mode: mode as Config["mode"], vmName: str("vmName"), image: str("image"),
    registryAuth: str("registryAuth") ?? process.env.EXE_DEV_REGISTRY_AUTH,
    sshPrivateKey: str("sshPrivateKey") ?? process.env.EXE_DEV_SSH_PRIVATE_KEY,
    sshIdentityFile: str("sshIdentityFile") ?? process.env.EXE_DEV_SSH_KEY_FILE,
    knownHosts: str("knownHosts"), strictHostKeyChecking: (str("strictHostKeyChecking") ?? "accept-new") as Config["strictHostKeyChecking"],
    timeoutMs: Number(raw.timeoutMs ?? 300000), cpu: Number(raw.cpu ?? 2),
    memory: str("memory") ?? "4GB", disk: str("disk") ?? "20GB",
  };
  if (mode !== "create" && mode !== "attach") throw new Error("mode must be create or attach");
  if (config.vmName && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.vmName)) throw new Error("Invalid VM name");
  if (mode === "attach" && !config.vmName) throw new Error("Attaching requires a named compatible VM; existing per-run configurations must be migrated explicitly");
  if (mode === "create" && !config.image?.match(/^[-a-zA-Z0-9./_:]+@sha256:[a-f0-9]{64}$/)) throw new Error("Creating requires a compatible image pinned by sha256 digest");
  if (!["yes", "accept-new"].includes(config.strictHostKeyChecking)) throw new Error("SSH host key checking cannot be disabled");
  if (!config.sshPrivateKey && !config.sshIdentityFile) throw new Error("Register an SSH key with exe.dev and configure sshPrivateKey or sshIdentityFile");
  if (config.sshPrivateKey && !/^[a-f0-9-]{36}$/i.test(config.sshPrivateKey)) {
    const error = validateSshPrivateKey(config.sshPrivateKey); if (error) throw new Error(error);
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 86400000) throw new Error("timeoutMs must be 1000–86400000");
  if (!Number.isInteger(config.cpu) || config.cpu < 1 || config.cpu > 64) throw new Error("Invalid CPU count");
  for (const size of [config.memory, config.disk]) if (!/^\d+(?:GB|G)?$/.test(size)) throw new Error("Invalid resource size");
  for (const obsolete of ["setupScript", "prompt", "command", "sshUser", "apiUrl"]) {
    if (raw[obsolete]) throw new Error(`${obsolete} is not supported by durable exe.dev environments`);
  }
  return config;
}
interface Scope { companyId: string; environmentId: string; }
interface Binding {
  config: Config; scope: string; companyId: string; vm: string; root: string; unit: string;
  leaseId: string; bindingId: string; image: Record<string, unknown>;
}
const bindings = new Map<string, Binding>();
const scopeId = (p: Scope) => hash(`${p.companyId}\0${p.environmentId}`);
const scopedKey = (p: Scope, leaseId: string) => `${scopeId(p)}:${leaseId}`;
const vmHost = (vm: string) => `${vm}.exe.xyz`;
let context: PluginContext | undefined;

async function management(config: Config, command: string): Promise<Record<string, unknown>> {
  let output: string;
  try { output = await ssh(config, "exe.dev", command, undefined, Boolean(config.registryAuth)); }
  catch (error) { throw new Error(config.registryAuth ? String((error as Error).message).split(config.registryAuth).join("[REDACTED]") : (error as Error).message); }
  const result = JSON.parse(output);
  if (result.error) throw new Error(`exe.dev: ${config.registryAuth ? String(result.error).split(config.registryAuth).join("[REDACTED]") : String(result.error)}`);
  return result;
}
async function findVm(config: Config, name: string): Promise<Record<string, unknown> | undefined> {
  const result = await management(config, "ls -l --json");
  return (result.vms as Record<string, unknown>[]).find((vm) => vm.vm_name === name);
}
class MissingVmError extends Error {}
async function resolveVm(config: Config, params: Scope & { resourceBinding?: { resourceId: string; identity: string; companyId: string } }, provision: boolean): Promise<string> {
  const name = config.vmName ?? `paperclip-${scopeId(params).slice(0, 20)}`;
  if (params.resourceBinding && (params.resourceBinding.resourceId !== name || params.resourceBinding.companyId !== params.companyId)) throw new Error("Durable resource binding does not match this environment");
  let vm = await findVm(config, name);
  if (!vm && provision && config.mode === "create" && !params.resourceBinding) {
    // Name is stable across retries and competing workers. An uncertain create
    // is reconciled by lookup; never issue a randomly named second VM.
    try {
      await management(config, `new --json --no-email --tag=${quote("paperclip-" + scopeId(params))} --name=${quote(name)} --image=${quote(config.image!)} ${config.registryAuth ? `--registry-auth=${quote(config.registryAuth)}` : ""} --cpu=${config.cpu} --memory=${quote(config.memory)} --disk=${quote(config.disk)}`);
    } catch (error) {
      vm = await findVm(config, name);
      if (!vm) throw error;
    }
    vm ??= await findVm(config, name);
  }
  if (!vm) throw new MissingVmError(`exe.dev VM ${name} is missing; no automatic replacement is performed`);
  if (vm.proxy_share !== "private") throw new Error("exe.dev VM must use private HTTP sharing");
  return name;
}
async function inspect(config: Config, vm: string): Promise<Record<string, unknown>> {
  const output = await ssh(config, vmHost(vm), "test -r /opt/paperclip-exe/lease.mjs && command -v node >/dev/null && command -v paperclip-runnerd >/dev/null && test -r /opt/paperclip-runner/provider-pack/provider-pack.json && sudo -n true && cat /opt/paperclip-exe/image.json");
  const image = JSON.parse(output);
  if (image.schema !== 1 || !image.sourceRevision || !image.contentId) throw new Error("Incompatible exe.dev image; recreate explicitly from a published Paperclip image");
  return image;
}
async function claim(config: Config, vm: string, scope: string): Promise<string> {
  // Serialized across controller processes, not merely a worker-local mutex.
  const script = `const fs=require('fs'); const p='/var/lib/paperclip-exe/binding.json'; fs.mkdirSync('/var/lib/paperclip-exe',{recursive:true}); let b; try { b=JSON.parse(fs.readFileSync(p,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; b={scope:${JSON.stringify(scope)},id:require('crypto').randomUUID()}; fs.writeFileSync(p,JSON.stringify(b),{flag:'wx',mode:384}); } if(b.scope!==${JSON.stringify(scope)}) throw Error('VM belongs to another Paperclip company/environment'); process.stdout.write(b.id);`;
  return (await ssh(config, vmHost(vm), `sudo -n flock /var/lock/paperclip-exe-claim.lock node -e ${quote(script)}`)).trim();
}
function decodeBinding(params: PluginEnvironmentDriverBaseParams, lease: PluginEnvironmentLease): Binding {
  const config = parseConfig(params.config);
  const scope = scopeId(params);
  const match = lease.providerLeaseId?.match(/^([a-z0-9][a-z0-9-]{0,62}):([a-f0-9]{32}):([a-f0-9]{32})$/);
  if (!match || match[2] !== scope || (config.vmName && config.vmName !== match[1])) throw new Error("Lease does not belong to this exe.dev environment");
  const bindingId = lease.metadata?.bindingId;
  if (typeof bindingId !== "string" || !/^[a-f0-9-]{36}$/.test(bindingId)) throw new Error("Missing durable VM identity");
  return { config, scope, companyId: params.companyId, vm: match[1], root: `/var/lib/paperclip-exe/${scope}/${match[3]}`,
    unit: `paperclip-lease-${match[3]}.service`, leaseId: lease.providerLeaseId!, bindingId,
    image: (lease.metadata?.exeImageProvenance ?? {}) as Record<string, unknown> };
}
async function assertIdentity(binding: Binding) {
  const actual = JSON.parse(await ssh(binding.config, vmHost(binding.vm), "sudo -n cat /var/lib/paperclip-exe/binding.json"));
  if (actual.scope !== binding.scope || actual.id !== binding.bindingId) throw new Error("Durable VM identity changed; explicit recovery is required");
}
async function start(binding: Binding, expiresAt?: string | null) {
  const remaining = expiresAt ? Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) : null;
  if (remaining != null && (!Number.isFinite(remaining) || remaining < 1)) throw new Error("Lease deadline has expired");
  const script = [
    `mkdir -p ${quote(binding.root + "/workspace")} ${quote(binding.root + "/home")}`,
    `chown exedev:exedev ${quote(binding.root)} ${quote(binding.root + "/home")} ${quote(binding.root + "/workspace")}`,
    `if systemctl is-active --quiet ${quote(binding.unit)}; then :; else rm -f ${quote(binding.root + "/control.sock")}; systemd-run --quiet --collect --unit=${quote(binding.unit)} --uid=exedev --property=KillMode=control-group --property=TimeoutStopSec=10 ${remaining == null ? "" : `--property=RuntimeMaxSec=${remaining}`} /usr/bin/env HOME=${quote(binding.root + "/home")} PATH=/opt/paperclip-runner/provider-pack/node_modules/.bin:/usr/local/bin:/usr/bin:/bin PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT=/opt/paperclip-runner/provider-pack node ${SUPERVISOR} serve ${quote(binding.root)}; fi`,
    `for i in $(seq 1 100); do test -S ${quote(binding.root + "/control.sock")} && exit 0; sleep .1; done; exit 1`,
  ].join(" && ");
  await ssh(binding.config, vmHost(binding.vm), `sudo -n flock ${quote("/var/lock/" + binding.unit + ".lock")} sh -c ${quote(script)}`);
}
function leaseOf(binding: Binding, resumed: boolean, expiresAt?: string | null): PluginEnvironmentLease {
  return { providerLeaseId: binding.leaseId, expiresAt: expiresAt ?? null, metadata: {
    provider: "exe-dev", vmName: binding.vm, bindingId: binding.bindingId,
    resourceLifetime: "environment", environmentResourceBinding: { provider: "exe-dev", companyId: binding.companyId, resourceId: binding.vm, identity: binding.bindingId }, remoteCwd: binding.root + "/workspace", remoteHome: binding.root + "/home",
    httpsUrl: `https://${vmHost(binding.vm)}`, shellCommand: "bash", reuseLease: true,
    resumedLease: resumed, exeImageProvenance: binding.image, leaseDeadline: expiresAt ?? null,
  } };
}
async function acquire(params: PluginEnvironmentAcquireLeaseParams) {
  const config = parseConfig(params.config);
  const vm = await resolveVm(config, params, true);
  const image = await inspect(config, vm);
  const scope = scopeId(params);
  const bindingId = await claim(config, vm, scope);
  if (params.resourceBinding && bindingId !== params.resourceBinding.identity) throw new Error("Durable VM identity changed; explicit recovery is required");
  const id = randomUUID().replaceAll("-", "");
  const binding: Binding = { config, vm, image, scope, companyId: params.companyId, bindingId,
    root: `/var/lib/paperclip-exe/${scope}/${id}`, unit: `paperclip-lease-${id}.service`, leaseId: `${vm}:${scope}:${id}` };
  await start(binding, params.requestedExpiresAt);
  bindings.set(scopedKey(params, binding.leaseId), binding);
  return leaseOf(binding, false, params.requestedExpiresAt);
}
async function resume(params: PluginEnvironmentResumeLeaseParams) {
  const binding = decodeBinding(params, { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata });
  await resolveVm(binding.config, params, false);
  await assertIdentity(binding);
  binding.image = await inspect(binding.config, binding.vm);
  await start(binding, params.leaseMetadata?.leaseDeadline as string | undefined);
  bindings.set(scopedKey(params, binding.leaseId), binding);
  return leaseOf(binding, true, params.leaseMetadata?.leaseDeadline as string | undefined);
}
async function stop(params: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt | void> {
  if (!params.providerLeaseId) return;
  const binding = decodeBinding(params, { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata });
  await assertIdentity(binding);
  // systemctl stop waits for the cgroup to empty. A lost SSH response does not
  // produce a receipt. Repeat stop safely after reconnection to confirm it.
  const script = `load=$(systemctl show -p LoadState --value ${quote(binding.unit)}); if test "$load" != not-found; then systemctl stop ${quote(binding.unit)} || exit $?; fi; state=$(systemctl show -p ActiveState --value ${quote(binding.unit)}); test "$state" = inactive -o "$state" = failed`;
  await ssh(binding.config, vmHost(binding.vm), `sudo -n flock ${quote("/var/lock/" + binding.unit + ".lock")} sh -c ${quote(script)}`);
  bindings.delete(scopedKey(params, binding.leaseId));
  return { providerLeaseId: binding.leaseId, state: "stopped" };
}

interface Command { command: string; args?: readonly string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; }
async function channel(binding: Binding, command: Command, onData: (stream: "stdout" | "stderr", data: Buffer) => void) {
  const { child } = await openSsh(binding.config, vmHost(binding.vm), `node ${SUPERVISOR} call ${quote(binding.root)}`);
  let settled = false;
  let stderr = "";
  let resolve!: (result: PluginEnvironmentExecuteResult) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<PluginEnvironmentExecuteResult>((yes, no) => { resolve = yes; reject = no; });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, (command.timeoutMs ?? binding.config.timeoutMs) + 20000);
  child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-8192); });
  lines.on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.type === "stdout" || frame.type === "stderr") onData(frame.type, Buffer.from(frame.data, "base64"));
      else if (frame.type === "exit") {
        settled = true; clearTimeout(timer);
        if (frame.error) reject(new Error(frame.error));
        else resolve({ exitCode: frame.code, signal: frame.signal, timedOut: frame.timedOut, stdout: "", stderr: "" });
        child.stdin.end();
      }
    } catch { child.kill("SIGKILL"); }
  });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", () => { clearTimeout(timer); if (!settled) reject(new Error(`exe.dev command transport closed without an exit receipt: ${stderr}`)); });
  const send = (frame: unknown) => child.stdin.write(JSON.stringify(frame) + "\n");
  send({ type: "start", command: command.command, cwd: command.cwd, env: command.env, args: command.args ?? [], timeoutMs: command.timeoutMs ?? binding.config.timeoutMs });
  return { result, send, close: () => child.kill("SIGTERM") };
}
type Channel = Awaited<ReturnType<typeof channel>>;
const channels = new Map<string, { id: string; channel: Channel }>();

const plugin = definePlugin({
  async setup(ctx) { context = ctx; },
  async onHealth() { return { status: "ok", message: "exe.dev durable environment provider ready" }; },
  async onEnvironmentValidateConfig(params) {
    try { parseConfig(params.config); return { ok: true }; }
    catch (error) { return { ok: false, errors: [String((error as Error).message)] }; }
  },
  async onEnvironmentProbe(params) {
    try {
      const config = parseConfig(params.config);
      const vm = await resolveVm(config, params, false);
      const image = await inspect(config, vm);
      return { ok: true, summary: `Compatible durable VM ${vm}; probe does not modify or delete it.`, metadata: { vmName: vm, image } };
    } catch (error) {
      if (error instanceof MissingVmError && params.config.mode === "create") {
        return { ok: true, summary: "SSH account verified. The pinned image will be checked when the first run creates the durable VM." };
      }
      return { ok: false, summary: (error as Error).message };
    }
  },
  onEnvironmentAcquireLease: acquire,
  onEnvironmentResumeLease: resume,
  async onEnvironmentReleaseLease(params) { if (params.cancelActiveWork || params.config.reuseLease !== true) return await stop(params); },
  onEnvironmentDestroyLease: stop,
  async onEnvironmentRealizeWorkspace(params) {
    const binding = decodeBinding(params, params.lease);
    return { cwd: binding.root + "/workspace", metadata: { provider: "exe-dev", resourceLifetime: "environment" } };
  },
  async onEnvironmentExecute(params) {
    const binding = decodeBinding(params, params.lease);
    bindings.set(scopedKey(params, binding.leaseId), binding);
    let stdout = ""; let stderr = "";
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const active = await channel(binding, params, (stream, data) => {
      const text = decoders[stream].write(data);
      if (stream === "stdout") stdout += text; else stderr += text;
      context?.execution.log(stream, text);
    });
    if (params.stdin) {
      const bytes = Buffer.from(params.stdin);
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        active.send({ type: "stdin", data: bytes.subarray(offset, offset + 65536).toString("base64") });
      }
    }
    active.send({ type: "end" });
    const result = await active.result;
    return { ...result, stdout: stdout + decoders.stdout.end(), stderr: stderr + decoders.stderr.end() };
  },
  async onDuplexChannelOpen(params) {
    if (channels.has(params.hostRouteId)) throw new Error("Duplicate duplex route");
    const binding = bindings.get(scopedKey(params, params.providerLeaseId));
    if (!binding || params.driverKey !== "exe-dev") throw new Error("Unknown scoped exe.dev lease");
    const id = randomUUID();
    const active = await channel(binding, { command: params.command[0], args: params.command.slice(1), timeoutMs: 86400000 }, (stream, data) => {
      if (stream === "stdout") context?.duplexChannel.data(params.hostRouteId, id, data);
    });
    channels.set(params.hostRouteId, { id, channel: active });
    void active.result.then(
      (result) => context?.duplexChannel.exit(params.hostRouteId, id, result.exitCode),
      () => context?.duplexChannel.exit(params.hostRouteId, id, null, true),
    );
    return { hostRouteId: params.hostRouteId, workerSessionId: id };
  },
  async onDuplexChannelWrite(params) {
    const entry = channels.get(params.hostRouteId); const data = decodeChannelBytes(params.data);
    if (entry?.id === params.workerSessionId && data) entry.channel.send({ type: "stdin", data: Buffer.from(data).toString("base64") });
  },
  async onDuplexChannelStop(params) {
    const entry = channels.get(params.hostRouteId);
    if (entry?.id === params.workerSessionId) entry.channel.send({ type: "cancel" });
  },
  async onDuplexChannelClose(params) {
    const entry = channels.get(params.hostRouteId);
    if (entry) { entry.channel.send({ type: "cancel" }); entry.channel.close(); channels.delete(params.hostRouteId); }
    return { hostRouteId: params.hostRouteId, ...(entry ? { workerSessionId: entry.id } : {}) };
  },
  async onShutdown() { for (const entry of channels.values()) entry.channel.close(); channels.clear(); bindings.clear(); },
});
export default plugin;
