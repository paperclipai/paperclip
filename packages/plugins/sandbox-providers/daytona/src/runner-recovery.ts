import { posix } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentRunnerRecoveryParams, PluginEnvironmentRunnerRecoveryResult } from "@paperclipai/plugin-sdk";
import { handleDaytonaRunProcessControl } from "./run-process-control.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export const MAX_RECOVERY_STATE_BYTES = 8 * 1024 * 1024;
/** Fixed confined read, with a bounded allocation even if the file grows after
 * stat. Open-FD realpath verification rejects swapped parent symlinks. The
 * durable authority independently validates the returned state identity. */
export const runnerRecoveryStateSource = `
const fs=require('node:fs/promises'), constants=require('node:fs').constants, path=require('node:path');
(async()=>{
  let file;
  try {
    const input=JSON.parse(process.env.PAPERCLIP_RUNNER_RECOVERY_READ);
    delete process.env.PAPERCLIP_RUNNER_RECOVERY_READ;
    const root=input.root, hash=input.sessionHash;
    if(typeof root!=='string'||root==='/'||root.length>4096||root.includes('\\0')||path.resolve(root)!==root||!/^[a-f0-9]{64}$/.test(hash)) throw 0;
    const target=path.join(root,'.paperclip-runtime','paperclip-runner','sessions',hash,'runner','runner-state.json');
    if(await fs.realpath(root)!==root||await fs.realpath(target)!==target) throw 0;
    file=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await file.stat();
    if(!stat.isFile()||stat.uid!==process.getuid()||stat.size>${MAX_RECOVERY_STATE_BYTES}||await fs.realpath('/proc/self/fd/'+file.fd)!==target) throw 0;
    const buffer=Buffer.alloc(${MAX_RECOVERY_STATE_BYTES + 1});
    let bytes=0;
    while(bytes<buffer.length){const result=await file.read(buffer,bytes,buffer.length-bytes,bytes);if(result.bytesRead===0)break;bytes+=result.bytesRead;}
    if(bytes>${MAX_RECOVERY_STATE_BYTES}) throw 0;
    const state=JSON.parse(buffer.subarray(0,bytes).toString('utf8'));
    if(!state||typeof state!=='object'||Array.isArray(state)||state.runId!==input.runId) throw 0;
    process.stdout.write(JSON.stringify(state));
  } catch { process.exitCode=1; }
  finally { if(file) await file.close(); }
})();`;

/** Caller verifies the saved connection before lookup. This handler verifies
 * fresh physical and kernel ownership; neither branch changes compute state. */
export async function handleDaytonaRunnerRecovery(sandbox: Sandbox, params: PluginEnvironmentRunnerRecoveryParams,
  generation: (sandbox: Sandbox) => string,
): Promise<PluginEnvironmentRunnerRecoveryResult> {
  const unverified = { state: "unverified" } as const;
  if (!uuid.test(params.runId) || typeof params.workspaceRoot !== "string" || params.workspaceRoot === "/"
    || params.workspaceRoot.length > 4096 || params.workspaceRoot.includes("\0") || posix.resolve(params.workspaceRoot) !== params.workspaceRoot
    || !/^[a-f0-9]{64}$/.test(params.sessionHash) || !["ingress", "read_state"].includes(params.operation)) return unverified;
  const inspect = () => handleDaytonaRunProcessControl(sandbox, { ...params, operation: { action: "inspect" } });
  const observed = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(observed.state)) return unverified;
  if (params.operation === "ingress") {
    if (observed.state !== "running") return unverified;
    const preview = await sandbox.getPreviewLink(43127);
    if (typeof preview.url !== "string" || typeof preview.token !== "string" || !preview.token || /[\r\n]/.test(preview.token)) return unverified;
    const url = new URL(preview.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return unverified;
    if ((await inspect()).state !== "running" || sandbox.state !== "started") return unverified;
    url.protocol = "wss:"; url.pathname = `/api/runner/v1/connect/${params.runId}`;
    return { state: "ready", workspaceConnection: params.workspaceConnection, endpoint: {
      kind: "authenticated_websocket", websocketUrl: url.toString(), secretHeaders: [{ name: "X-Daytona-Preview-Token", value: preview.token }], generation: generation(sandbox),
    } };
  }
  const result = await sandbox.process.executeCommand(`node -e ${quote(runnerRecoveryStateSource)}`, "/tmp", {
    PAPERCLIP_RUNNER_RECOVERY_READ: JSON.stringify({ root: params.workspaceRoot, sessionHash: params.sessionHash, runId: params.runId }), NODE_OPTIONS: "", NODE_PATH: "",
  }, 12);
  if (result.exitCode !== 0 || typeof result.result !== "string" || Buffer.byteLength(result.result) > MAX_RECOVERY_STATE_BYTES) return unverified;
  let state: unknown;
  try { state = JSON.parse(result.result); } catch { return unverified; }
  if (!state || typeof state !== "object" || Array.isArray(state) || (state as Record<string, unknown>).runId !== params.runId) return unverified;
  const after = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(after.state)) return unverified;
  return { state: "ready", workspaceConnection: params.workspaceConnection, runnerState: state as Record<string, unknown> };
}
