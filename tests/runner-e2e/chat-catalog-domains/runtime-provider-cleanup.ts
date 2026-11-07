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
interface ProviderIdentity { pid: number; parentPid: number; uid: number; startedAt: string; executable: string; digest: string; appServer: boolean; openCodeServe: boolean; proxyScript?: string; proxyDigest?: string }
interface SuspendedOwner { identity: ProviderIdentity; runId: string; timer: ReturnType<typeof setTimeout> }
const suspended = new WeakMap<ChatCatalogContext, SuspendedOwner>();
const retainedProvider = new WeakMap<ChatCatalogContext, ProviderIdentity>();
export function matchesOwnedProvider(input: { identity: ProviderIdentity; expected: { providerPid: number; providerStartedAt: string; runnerPid: number; providerParentPid?: number; uid: number; runStartedAt: string; kind?: "codex" | "opencode"; executable?: string; digest?: string; proxyScript?: string; proxyDigest?: string } }) {
  const { identity: p, expected: e } = input;
  return Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid !== process.pid && p.pid === e.providerPid && p.pid !== e.runnerPid && p.parentPid === (e.providerParentPid ?? e.runnerPid) && p.uid === e.uid
    && p.startedAt === e.providerStartedAt && Date.parse(p.startedAt) + 1_000 >= Date.parse(e.runStartedAt)
    && /^[a-f0-9]{64}$/.test(p.digest)
    && (e.kind === "opencode" && !e.proxyScript
      // Direct OpenCode server: the runner spawns the pinned `opencode serve` itself.
      ? p.openCodeServe && !p.proxyScript && !p.appServer
      : e.kind === "opencode"
      ? !!e.executable && !!e.proxyScript && /^[a-f0-9]{64}$/.test(e.digest ?? "") && /^[a-f0-9]{64}$/.test(e.proxyDigest ?? "")
        && p.executable === e.executable && p.digest === e.digest && p.proxyScript === e.proxyScript && p.proxyDigest === e.proxyDigest && !p.appServer
      : p.appServer === true && path.basename(p.executable) === "codex");
}
async function providerIdentity(pid: number): Promise<ProviderIdentity> {
  try {
    const ps = async (field: string) => (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", `${field}=`], { timeout: 5_000, maxBuffer: 65_536 })).stdout.trim();
    const [uid, parent, executable, command, startedAt] = await Promise.all([ps("uid"), ps("ppid"), ps("comm"), ps("args"), readProcessStartedAt(pid)]);
    // A pinned binary may be executed from an inherited descriptor (/proc/self/fd/N); its real
    // executable is then only reachable through the kernel's /proc/<pid>/exe link.
    const canonical = await realpath(ownedNativeExecutablePath(pid, executable)).catch(() => realpath(`/proc/${pid}/exe`));
    const args = command.split(/\s+/);
    // node may carry runtime flags before the script; the absolute proxy script is the last argument.
    const script = args.at(-1)!, flags = args.slice(1, -1);
    const proxy = args.length >= 2 && path.isAbsolute(script) && path.basename(script) === "opencode-app-server-proxy.cjs" && flags.every(arg => /^--[a-z][a-z0-9-]*(?:=[^\s]*)?$/.test(arg)) ? await realpath(script) : undefined;
    const proxyDigest = proxy ? createHash("sha256").update(await readFile(proxy)).digest("hex") : undefined;
    if (!startedAt) throw new Error("missing start identity");
    return { pid, parentPid: Number(parent), uid: Number(uid), startedAt, executable: canonical,
      digest: createHash("sha256").update(await readFile(canonical)).digest("hex"), appServer: /(?:^|\s)app-server(?=\s|$)/.test(command),
      // `opencode serve` runs either as its own binary or as node running the opencode launcher script.
      openCodeServe: args.includes("serve") && (/^opencode/.test(path.basename(canonical))
        || args.slice(1, args.indexOf("serve")).some(arg => path.isAbsolute(arg) && /^opencode(?:\.[cm]?js)?$/.test(path.basename(arg)))), proxyScript: proxy, proxyDigest };
  } catch { throw new Error("Provider cleanup fixture could not qualify the exact owned process; private diagnostics withheld"); }
}
/** The single qualifying provider among the verified runner's descendants (depth <= 4). The
 * launch path may wrap the provider, so it need not be a direct child. Records a closed summary of
 * what it saw (depth, executable basename, qualification flags) without command lines. */
async function soleProviderDescendant(ctx: ChatCatalogContext, runnerPid: number, kind: "codex" | "opencode"): Promise<{ pid: number; parentPid: number } | undefined> {
  const rows = (await promisify(execFile)("/bin/ps", ["-A", "-o", "pid=,ppid="], { timeout: 5_000, maxBuffer: 1_048_576 })).stdout
    .split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, parent]) => Number.isSafeInteger(pid) && Number.isSafeInteger(parent));
  const seen: Array<{ depth: number; command: string | null; argCount: number | null; scripts: string[]; hasServe: boolean; executable: string | null; proxy: boolean; appServer: boolean; openCodeServe: boolean }> = [];
  const providers: Array<{ pid: number; parentPid: number }> = [];
  let frontier = [runnerPid];
  for (let depth = 1; depth <= 4 && frontier.length; depth += 1) {
    const next = rows.filter(([, parent]) => frontier.includes(parent!)).map(([pid, parent]) => ({ pid: pid!, parent: parent! }));
    for (const { pid, parent } of next) {
      const identity = await providerIdentity(pid).catch(() => undefined);
      const args = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "args="], { timeout: 5_000, maxBuffer: 65_536 }).then(out => out.stdout.trim().split(/\s+/), () => null);
      const command = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 5_000, maxBuffer: 65_536 }).then(out => path.basename(out.stdout.trim()) || null, () => null);
      seen.push({ depth, command, argCount: args?.length ?? null, scripts: (args ?? []).filter(arg => path.isAbsolute(arg)).map(arg => path.basename(arg)).slice(0, 8), hasServe: !!args?.includes("serve"), executable: identity ? path.basename(identity.executable) : null, proxy: !!identity?.proxyScript, appServer: !!identity?.appServer, openCodeServe: !!identity?.openCodeServe });
      if (identity && (kind === "opencode" ? !!identity.proxyScript || identity.openCodeServe : identity.appServer)) providers.push({ pid, parentPid: parent });
    }
    frontier = next.map(row => row.pid);
  }
  await ctx.input.evidence("runtime-cleanup-provider-search.json", { kind, descendants: seen, qualifying: providers.length });
  return providers.length === 1 ? providers[0] : undefined;
}
/** This does not signal any group or control ACK timing. Actual public Stop must immediately follow. */
export async function suspendOwnedProviderForCleanup(ctx: ChatCatalogContext, binding: { runId: string; issueId: string; agentId: string }) {
  if (ctx.scenario.id !== "recovery.post-stop-message" || suspended.has(ctx)) throw new Error("Bounded provider cleanup suspension is exclusive to the selected post-stop scenario");
  const { run, identity: runner } = await verifyOwnedNativeRunner(ctx, binding);
  const checkpoint = run.runnerProfileJson?.sessionCheckpoint as { process?: { providerPid?: number; providerProcessStartedAt?: string } } | undefined;
  const provider = run.runnerProfileJson?.nativeExecutionInput as { provider?: { kind?: string } } | undefined;
  const kind = provider?.provider?.kind;
  const events = await collectRunEvents<{ seq?: number; payload?: { prpEvent?: { runId?: string; normalizedSessionId?: string; sourceKind?: string; sourceInstanceId?: string; eventType?: string; payload?: { processId?: number; processStartedAt?: string | null; providerSessionId?: string; driverSessionId?: string } } } }>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const sessionReceipts = events.map(row => row.payload?.prpEvent).filter(e => e?.runId === run.id && e.sourceKind === "runner" && e.sourceInstanceId === run.runnerInstanceId && e.normalizedSessionId === run.nativeSessionId
    && ["session.started", "session.resumed"].includes(e.eventType ?? "") && !!(e.payload?.providerSessionId ?? e.payload?.driverSessionId));
  if (kind !== "codex" && kind !== "opencode") throw new Error("Actual public native session lacks a supported local provider kind");
  if (!sessionReceipts.length) throw new Error("Provider suspension lacks the exact durable native session receipt");
  // The runnerd transport records the provider in the checkpoint. When the session runs inside the
  // verified runnerd itself, the provider is its direct child: the one qualifying child is chosen,
  // and every ownership check below still applies to it.
  const descendant = checkpoint?.process?.providerPid ? undefined : await soleProviderDescendant(ctx, runner.pid, kind);
  const pid = checkpoint?.process?.providerPid ?? descendant?.pid;
  const started = checkpoint?.process?.providerPid ? checkpoint.process.providerProcessStartedAt : pid ? await readProcessStartedAt(pid) : undefined;
  if (!Number.isSafeInteger(pid) || !pid || !started) throw new Error("Actual public native session lacks a qualified local provider PID/start identity");
  const viaProxy = kind === "opencode" && !!(await providerIdentity(pid)).proxyScript;
  const executable = viaProxy ? await realpath(process.execPath) : undefined;
  const proxyScript = viaProxy ? await realpath(fileURLToPath(new URL("../../../packages/paperclip-runner/dist/cli/opencode-app-server-proxy.cjs", import.meta.url))) : undefined;
  const digest = executable ? createHash("sha256").update(await readFile(executable)).digest("hex") : undefined;
  const proxyDigest = proxyScript ? createHash("sha256").update(await readFile(proxyScript)).digest("hex") : undefined;
  if (checkpoint?.process?.providerPid && !sessionReceipts.some(e => e?.payload?.processId === pid)) throw new Error("Provider suspension lacks the exact durable native session/PID receipt");
  const expected: Parameters<typeof matchesOwnedProvider>[0]["expected"] = { providerPid: pid, providerStartedAt: started, runnerPid: runner.pid, ...(descendant ? { providerParentPid: descendant.parentPid } : {}), uid: runner.uid, runStartedAt: String(run.startedAt), kind, executable, digest, proxyScript, proxyDigest };
  const first = await providerIdentity(pid), second = await providerIdentity(pid);
  if (!matchesOwnedProvider({ identity: first, expected }) || !matchesOwnedProvider({ identity: second, expected }) || JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Provider cleanup suspension rejected changed or unowned process identity");
  process.kill(pid, "SIGSTOP"); retainedProvider.set(ctx, second);
  const timer = setTimeout(() => { void releaseOwnedCleanupProvider(ctx).catch(() => undefined); }, 8_000); timer.unref(); suspended.set(ctx, { identity: second, runId: run.id, timer });
  await ctx.input.evidence("runtime-cleanup-owned-provider.json", { runId: run.id, companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, providerPid: pid, providerStartedAt: started,
    providerKind: kind, cleanupBoundary: kind === "opencode" ? viaProxy ? "owned-protocol-proxy-retirement" : "owned-opencode-serve-retirement" : "owned-app-server-retirement", sdkServerExitRequired: false, sameUid: true, directOwnedRunnerParent: true, proxyScriptSha256: proxyDigest, executableSha256: second.digest, durableSessionReceipt: true, identityReadTwice: true, signal: "SIGSTOP", groupSignalled: false, maximumSuspensionMs: 8_000 });
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
