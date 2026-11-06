import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { collectRunEvents } from "../run-observations.js";
import { readProcessStartedAt } from "../../../server/src/services/hot-restart.js";
import { verifyOwnedNativeRunner, ownedNativeExecutablePath } from "./runtime-native-fault.js";
interface ProviderIdentity { pid: number; parentPid: number; uid: number; startedAt: string; executable: string; digest: string; appServer: boolean; proxyScript?: string; proxyDigest?: string }
interface SuspendedOwner { identity: ProviderIdentity; runId: string; timer: ReturnType<typeof setTimeout> }
const suspended = new WeakMap<ChatCatalogContext, SuspendedOwner>();
const retainedProvider = new WeakMap<ChatCatalogContext, ProviderIdentity>();
export function matchesOwnedProvider(input: { identity: ProviderIdentity; expected: { providerPid: number; providerStartedAt: string; runnerPid: number; uid: number; runStartedAt: string; kind?: "codex" | "opencode"; executable?: string; digest?: string; proxyScript?: string; proxyDigest?: string } }) {
  const { identity: p, expected: e } = input;
  return Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid !== process.pid && p.pid === e.providerPid && p.pid !== e.runnerPid && p.parentPid === e.runnerPid && p.uid === e.uid
    && p.startedAt === e.providerStartedAt && Date.parse(p.startedAt) + 1_000 >= Date.parse(e.runStartedAt)
    && /^[a-f0-9]{64}$/.test(p.digest)
    && (e.kind === "opencode"
      ? !!e.executable && !!e.proxyScript && /^[a-f0-9]{64}$/.test(e.digest ?? "") && /^[a-f0-9]{64}$/.test(e.proxyDigest ?? "")
        && p.executable === e.executable && p.digest === e.digest && p.proxyScript === e.proxyScript && p.proxyDigest === e.proxyDigest && !p.appServer
      : p.appServer === true && path.basename(p.executable) === "codex");
}
async function providerIdentity(pid: number): Promise<ProviderIdentity> {
  try {
    const ps = async (field: string) => (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", `${field}=`], { timeout: 5_000, maxBuffer: 65_536 })).stdout.trim();
    const [uid, parent, executable, command, startedAt] = await Promise.all([ps("uid"), ps("ppid"), ps("comm"), ps("args"), readProcessStartedAt(pid)]);
    const canonical = await realpath(ownedNativeExecutablePath(pid, executable));
    const args = command.split(/\s+/);
    const proxy = args.length === 2 && path.isAbsolute(args[1]!) && path.basename(args[1]!) === "opencode-app-server-proxy.cjs" ? await realpath(args[1]!) : undefined;
    const proxyDigest = proxy ? createHash("sha256").update(await readFile(proxy)).digest("hex") : undefined;
    if (!startedAt) throw new Error("missing start identity");
    return { pid, parentPid: Number(parent), uid: Number(uid), startedAt, executable: canonical,
      digest: createHash("sha256").update(await readFile(canonical)).digest("hex"), appServer: /(?:^|\s)app-server(?=\s|$)/.test(command), proxyScript: proxy, proxyDigest };
  } catch { throw new Error("Provider cleanup fixture could not qualify the exact owned process; private diagnostics withheld"); }
}
/** This does not signal any group or control ACK timing. Actual public Stop must immediately follow. */
export async function suspendOwnedProviderForCleanup(ctx: ChatCatalogContext, binding: { runId: string; issueId: string; agentId: string }) {
  if (ctx.scenario.id !== "recovery.post-stop-message" || suspended.has(ctx)) throw new Error("Bounded provider cleanup suspension is exclusive to the selected post-stop scenario");
  const { run, identity: runner } = await verifyOwnedNativeRunner(ctx, binding);
  const checkpoint = run.runnerProfileJson?.sessionCheckpoint as { process?: { providerPid?: number; providerProcessStartedAt?: string } } | undefined;
  const provider = run.runnerProfileJson?.nativeExecutionInput as { provider?: { kind?: string } } | undefined;
  const pid = checkpoint?.process?.providerPid, started = checkpoint?.process?.providerProcessStartedAt;
  const kind = provider?.provider?.kind;
  if ((kind !== "codex" && kind !== "opencode") || !Number.isSafeInteger(pid) || !pid || !started) throw new Error("Actual public native checkpoint lacks a qualified local provider PID/start identity");
  const executable = kind === "opencode" ? await realpath(process.execPath) : undefined;
  const proxyScript = kind === "opencode" ? await realpath(fileURLToPath(new URL("../../../packages/paperclip-runner/dist/cli/opencode-app-server-proxy.cjs", import.meta.url))) : undefined;
  const digest = executable ? createHash("sha256").update(await readFile(executable)).digest("hex") : undefined;
  const proxyDigest = proxyScript ? createHash("sha256").update(await readFile(proxyScript)).digest("hex") : undefined;
  const events = await collectRunEvents<{ seq?: number; payload?: { prpEvent?: { runId?: string; normalizedSessionId?: string; sourceKind?: string; sourceInstanceId?: string; eventType?: string; payload?: { processId?: number; providerSessionId?: string; driverSessionId?: string } } } }>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  if (!events.some(row => { const e = row.payload?.prpEvent; return e?.runId === run.id && e.sourceKind === "runner" && e.sourceInstanceId === run.runnerInstanceId && e.normalizedSessionId === run.nativeSessionId
    && ["session.started", "session.resumed"].includes(e.eventType ?? "") && e.payload?.processId === pid && !!(e.payload.providerSessionId ?? e.payload.driverSessionId); })) throw new Error("Provider suspension lacks the exact durable native session/PID receipt");
  const expected: Parameters<typeof matchesOwnedProvider>[0]["expected"] = { providerPid: pid, providerStartedAt: started, runnerPid: runner.pid, uid: runner.uid, runStartedAt: String(run.startedAt), kind, executable, digest, proxyScript, proxyDigest };
  const first = await providerIdentity(pid), second = await providerIdentity(pid);
  if (!matchesOwnedProvider({ identity: first, expected }) || !matchesOwnedProvider({ identity: second, expected }) || JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Provider cleanup suspension rejected changed or unowned process identity");
  process.kill(pid, "SIGSTOP"); retainedProvider.set(ctx, second);
  const timer = setTimeout(() => { void releaseOwnedCleanupProvider(ctx).catch(() => undefined); }, 8_000); timer.unref(); suspended.set(ctx, { identity: second, runId: run.id, timer });
  await ctx.input.evidence("runtime-cleanup-owned-provider.json", { runId: run.id, companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, providerPid: pid, providerStartedAt: started,
    providerKind: kind, cleanupBoundary: kind === "opencode" ? "owned-protocol-proxy-retirement" : "owned-app-server-retirement", sdkServerExitRequired: false, sameUid: true, directOwnedRunnerParent: true, proxyScriptSha256: proxyDigest, executableSha256: second.digest, durableSessionReceipt: true, identityReadTwice: true, signal: "SIGSTOP", groupSignalled: false, maximumSuspensionMs: 8_000 });
  return { providerPid: pid, providerStartedAt: started, runId: run.id };
}
export async function releaseOwnedCleanupProvider(ctx: ChatCatalogContext) {
  const owned = suspended.get(ctx); if (!owned) return; clearTimeout(owned.timer);
  try { process.kill(owned.identity.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { suspended.delete(ctx); return; } throw new Error("Owned provider cleanup liveness could not be verified"); }
  const fresh = await providerIdentity(owned.identity.pid);
  if (fresh.pid !== owned.identity.pid || fresh.uid !== owned.identity.uid || fresh.startedAt !== owned.identity.startedAt || fresh.executable !== owned.identity.executable || fresh.digest !== owned.identity.digest || fresh.proxyScript !== owned.identity.proxyScript || fresh.proxyDigest !== owned.identity.proxyDigest)
    throw new Error("Provider cleanup refuses signalling a reused or changed PID");
  process.kill(fresh.pid, "SIGCONT"); suspended.delete(ctx);
}

export async function ownedCleanupProviderHasExited(ctx: ChatCatalogContext) {
  const identity = retainedProvider.get(ctx); if (!identity) throw new Error("No retained exact provider identity for cleanup verification");
  try { process.kill(identity.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; return false; }
  const startedAt = await readProcessStartedAt(identity.pid);
  return !!startedAt && startedAt !== identity.startedAt;
}
