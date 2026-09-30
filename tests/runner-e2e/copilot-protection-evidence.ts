import { withoutProvenBootstrapReads, type BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CopilotToolNotice } from "./copilot-evidence.js";

/** A tool origin exists regardless of the first status emitted by the provider. */
export function countCopilotToolOrigins(notices: readonly CopilotToolNotice[]): number {
  return new Set(notices.filter(n => n.stage === "tool").map(n => JSON.stringify([n.runId, n.sessionId, n.turnId, n.toolCallId]))).size;
}

export interface CopilotCommandMatch {
  algorithm: "leading-ascii-horizontal-v1";
  canonicalCommandSha256: string;
  nativeCommandSha256: string;
  leadingWhitespace: string;
}
const commandDigest = (command: string) => `sha256:${createHash("sha256").update(command).digest("hex")}`;

/** Only the fixture-owned command plus at most eight leading SPACE/TAB bytes.
 * Never trim native evidence or canonicalize shell tokens, quotes or content. */
export function matchCopilotFixtureCommand(command: string, nativeCommandSha256: string): CopilotCommandMatch | null {
  if (!command || /^[ \t\r\n]/u.test(command) || !/^sha256:[a-f0-9]{64}$/u.test(nativeCommandSha256)) return null;
  let prefixes = [""];
  for (let length = 0; length <= 8; length++) {
    for (const leadingWhitespace of prefixes) {
      if (commandDigest(leadingWhitespace + command) === nativeCommandSha256) return {
        algorithm: "leading-ascii-horizontal-v1", canonicalCommandSha256: commandDigest(command), nativeCommandSha256, leadingWhitespace,
      };
    }
    prefixes = prefixes.flatMap(prefix => [prefix + " ", prefix + "\t"]);
  }
  return null;
}

/** Bind the relation to one complete native execution, including retry checks. */
export function findCopilotFixtureCommand(notices: readonly CopilotToolNotice[], command: string): { call: CopilotToolNotice; match: CopilotCommandMatch } | null {
  const tools = notices.filter(n => n.stage === "tool");
  const key = (n: CopilotToolNotice) => JSON.stringify([n.runId, n.sessionId, n.turnId, n.toolCallId]);
  const executions = tools.filter(n => n.operation === "execute" || n.commandSha256 !== undefined);
  if (new Set(executions.map(key)).size !== 1) return null;
  const first = executions[0]!;
  if (![first.runId, first.sessionId, first.turnId, first.toolCallId].every(Boolean)) return null;
  const group = tools.filter(n => key(n) === key(first));
  const pending = group.filter(n => n.status === "pending"), terminal = group.filter(n => n.status === "completed" || n.status === "failed");
  if (pending.length !== 1 || terminal.length !== 1 || terminal[0]!.status !== "completed"
    || group.some(n => n.seq < pending[0]!.seq || n.seq > terminal[0]!.seq)
    || pending[0]!.seq >= terminal[0]!.seq) return null;
  const call = pending[0]!, match = matchCopilotFixtureCommand(command, call.commandSha256 ?? "");
  if (!match || call.operation !== "execute" || call.mode !== "async" || call.detach !== false
    || group.some(n => (n.commandSha256 !== undefined && n.commandSha256 !== call.commandSha256)
      || (n.operation !== undefined && n.operation !== "execute") || (n.mode !== undefined && n.mode !== "async")
      || (n.detach !== undefined && n.detach !== false))) return null;
  return { call, match };
}

/** Capture independent evidence before a failed command match can abort grading. */
export async function observeCopilotFixtureCommand<T>(notices: readonly CopilotToolNotice[], command: string, local?: {
  fixture: { snapshot(): T; marker: string; close(): Promise<void> }; markerPath: string;
}) {
  const external = local?.fixture.snapshot();
  const markerMatches = local ? await readCopilotMarkerAfterCleanup(async () => {}, local.markerPath, local.fixture.marker) : undefined;
  const afterCleanupMarkerMatches = local ? await readCopilotMarkerAfterCleanup(() => local.fixture.close(), local.markerPath, local.fixture.marker) : undefined;
  return { external, markerMatches, afterCleanupMarkerMatches, matched: findCopilotFixtureCommand(notices, command) };
}

/** Permission requests may carry the target omitted by native tool updates. */
export function countCopilotEditOriginsForTarget(notices: readonly CopilotToolNotice[], target: string): number {
  const origins = new Map<string, CopilotToolNotice[]>();
  for (const notice of notices) {
    const key = JSON.stringify([notice.runId, notice.sessionId, notice.turnId, notice.toolCallId]);
    const group = origins.get(key) ?? [];
    group.push(notice); origins.set(key, group);
  }
  let count = 0;
  for (const group of origins.values()) {
    if (!group.some(n => n.target === target)) continue;
    if (group.some(n => (n.target !== undefined && n.target !== target) || (n.operation !== undefined && n.operation !== "edit"))) {
      throw new Error("Conflicting Copilot denied-target origin evidence");
    }
    const permissions = group.filter(n => n.stage !== "tool");
    const requestIds = new Set(permissions.map(n => n.requestId));
    if (requestIds.has(undefined) || requestIds.size > 1
      || permissions.filter(n => n.stage === "permission_requested").length > 1
      || permissions.filter(n => n.stage === "permission_delivered").length > 1) {
      throw new Error("Repeated or unbound Copilot denied-target permission");
    }
    const tools = group.filter(n => n.stage === "tool");
    const terminal = tools.filter(n => n.status === "completed" || n.status === "failed");
    if (terminal.length > 1 || tools.filter(n => n.status === "pending").length > 1
      || (terminal[0] && tools.some(n => n.seq > terminal[0]!.seq))) {
      throw new Error("Repeated Copilot denied-target tool lifecycle");
    }
    // A permission notice alone never proves that a native tool was attempted.
    if (tools.some(n => n.operation === "edit")) count++;
  }
  return count;
}

/** Re-read independently after cleanup; a pre-cleanup value is not evidence. */
export async function readCopilotMarkerAfterCleanup(close: () => Promise<void>, path: string, expected: string): Promise<boolean> {
  await close();
  try { return await readFile(path, "utf8") === expected; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export interface CopilotRemoteBinding {
  companyId: string; environmentId: string; runId: string; leaseId: string; sandboxId: string; image: string; remoteCwd: string;
}
export interface CopilotRemoteSnapshot {
  binding: CopilotRemoteBinding; observedAtMs: number; receivedAtMs: number; observedMonotonicNs: string; complete: boolean;
  workspace: Record<string, string>;
  targets: Record<string, { absent: boolean; sha256: string | null; parent: { dev: string; ino: string }; mutationCount: number; complete: boolean }>;
  watcher: { complete: boolean; targetMutationCount: number; workspaceMutationCount: number };
  processes: { captured: boolean; root: { pid: number; startTicks: string; bootId: string } | null; journal: Array<{ pid: number; ppid: number; startTicks: string; bootId: string }>; live: number[] };
  setup: { path: string; sha256: string | null; published: boolean };
  attached: { connections: number; failure: string | null; commandExit: { code: number; observedAtMs: number; observedMonotonicNs: string } | null;
    markerWrittenAtMs: number | null; markerWrittenMonotonicNs: string | null; clientExitedAtMs: number | null; clientExitedMonotonicNs: string | null } | null;
}
export interface CopilotRemoteFixture {
  binding: CopilotRemoteBinding; remoteCwd: string; actionFile: string;
  snapshot(label: string): Promise<CopilotRemoteSnapshot>;
  setupAttachedCommand(input: { marker: string; markerText: string; delayMs: number }): Promise<{ command: string; commandSha256: string }>;
  finish(): Promise<CopilotRemoteSnapshot>; readFile(relative: string): Promise<Buffer>; close(): Promise<void>;
}
export interface CopilotRemoteBootstrap {
  prompt(nonce: string): string;
  bindAndRelease(input: { issueId: string; runId: string; targets: readonly string[];
    actionPrompt(fixture: CopilotRemoteFixture): Promise<string> | string }): Promise<CopilotRemoteFixture>;
}
export function assertCopilotRemoteSnapshot(s: CopilotRemoteSnapshot, binding: CopilotRemoteBinding): void {
  const keys: Array<keyof CopilotRemoteBinding> = ["companyId", "environmentId", "runId", "leaseId", "sandboxId", "image", "remoteCwd"];
  if (!s.complete || !s.watcher.complete || !keys.every(k => typeof binding[k] === "string" && binding[k].length > 0 && s.binding[k] === binding[k])
    || !/^.+@sha256:[a-f0-9]{64}$/u.test(binding.image) || !binding.remoteCwd.startsWith("/") || binding.remoteCwd.split("/").some(p => p === ".." || p === ".")
    || !Number.isSafeInteger(s.observedAtMs) || s.observedAtMs < 0 || !Number.isSafeInteger(s.receivedAtMs) || !/^\d+$/u.test(s.observedMonotonicNs)
    || ![s.watcher.targetMutationCount, s.watcher.workspaceMutationCount].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Incomplete Copilot remote lease/watch receipt");
}
export function assertCopilotRemoteRetirement(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot): void {
  assertCopilotRemoteSnapshot(s, baseline.binding);
  const root = s.processes.root, original = baseline.processes.root;
  if (!root || !original || !baseline.processes.captured || !s.processes.captured || s.processes.live.length !== 0
    || root.pid !== original.pid || root.startTicks !== original.startTicks || root.bootId !== original.bootId
    || !Number.isSafeInteger(root.pid) || root.pid < 2 || !/^\d+$/u.test(root.startTicks) || !/^[a-f0-9-]{36}$/iu.test(root.bootId)
    || !s.processes.journal.some(p => p.pid === root.pid && p.startTicks === root.startTicks && p.bootId === root.bootId)
    || !s.processes.journal.every(p => p.bootId === root.bootId && /^\d+$/u.test(p.startTicks) && Number.isSafeInteger(p.pid) && p.pid > 1)
    || !s.setup.published || s.setup.path !== baseline.setup.path || !/^sha256:[a-f0-9]{64}$/u.test(s.setup.sha256 ?? "")
    || BigInt(s.observedMonotonicNs) < BigInt(baseline.observedMonotonicNs)) throw new Error("Copilot remote retirement is unproven");
}
export function copilotRemoteDeniedSample(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot, target: string, phase: "before-request" | "pending" | "after-decision" | "terminal" | "after-cleanup") {
  assertCopilotRemoteSnapshot(s, baseline.binding);
  const t = s.targets[target], before = baseline.targets[target];
  if (!t?.complete || !before?.complete || !/^\d+$/u.test(t.parent.dev) || !/^\d+$/u.test(t.parent.ino)
    || t.parent.dev !== before.parent.dev || t.parent.ino !== before.parent.ino || t.mutationCount !== 0
    || s.watcher.targetMutationCount !== 0 || s.watcher.workspaceMutationCount !== baseline.watcher.workspaceMutationCount
    || JSON.stringify(Object.entries(s.workspace).sort()) !== JSON.stringify(Object.entries(baseline.workspace).sort())) throw new Error("Copilot remote denied target changed or observation was incomplete");
  return { phase, observedAtMs: s.observedAtMs, exists: t.absent !== true || t.sha256 !== null };
}
/** Only typed reads before the tested operation can be bootstrap work. */
export function copilotActionNotices(notices: readonly CopilotToolNotice[], origin: CopilotToolNotice, proof?: BootstrapReadProof): CopilotToolNotice[] {
  return withoutProvenBootstrapReads(notices, origin, proof);
}
export function assertCopilotRemoteAttached(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot, terminalAt: number) {
  assertCopilotRemoteRetirement(s, baseline);
  const a = s.attached;
  if (!a || a.failure !== null || a.connections !== 1 || a.commandExit?.code !== 0 || a.markerWrittenAtMs === null || a.clientExitedAtMs === null
    || !/^\d+$/u.test(a.commandExit.observedMonotonicNs) || !/^\d+$/u.test(a.markerWrittenMonotonicNs ?? "") || !/^\d+$/u.test(a.clientExitedMonotonicNs ?? "")
    || BigInt(a.commandExit.observedMonotonicNs) > BigInt(a.markerWrittenMonotonicNs!) || BigInt(a.markerWrittenMonotonicNs!) > BigInt(a.clientExitedMonotonicNs!)
    || BigInt(a.clientExitedMonotonicNs!) > BigInt(s.observedMonotonicNs)
    || ![terminalAt, a.commandExit.observedAtMs, a.markerWrittenAtMs, a.clientExitedAtMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || BigInt(a.commandExit.observedMonotonicNs) < BigInt(baseline.observedMonotonicNs)
    || a.commandExit.observedAtMs >= terminalAt || a.markerWrittenAtMs >= terminalAt || a.clientExitedAtMs >= terminalAt) throw new Error("Copilot remote attached command did not settle before terminal");
  return a;
}

/** Await baseline and exact command construction before the bootstrap can publish. */
export async function prepareCopilotRemoteAction(input: {
  fixture: CopilotRemoteFixture; companyId: string; environmentId: string; runId: string;
  target: string; prompt: string; markerText?: string;
}) {
  const f = input.fixture;
  if (f.binding.companyId !== input.companyId || f.binding.environmentId !== input.environmentId || f.binding.runId !== input.runId || f.remoteCwd !== f.binding.remoteCwd) throw new Error("Foreign Copilot remote bootstrap binding");
  const command = input.markerText === undefined ? undefined : await f.setupAttachedCommand({ marker: input.target, markerText: input.markerText, delayMs: 4000 });
  const baseline = await f.snapshot("before-action-publication"); assertCopilotRemoteSnapshot(baseline, f.binding);
  if (baseline.setup.published || baseline.setup.path !== f.actionFile || !baseline.processes.captured || baseline.processes.live.length === 0) throw new Error("Copilot action was not held behind the remote observer");
  const target = baseline.targets[input.target];
  if (!target?.complete || !target.absent || target.sha256 !== null || target.mutationCount !== 0) throw new Error("Copilot remote target was present or unobserved before action");
  return { baseline, command, prompt: `${input.prompt}\nThe admitted remote workspace is ${f.remoteCwd}.${command ? `\nThe exact supplied command is:\n${command.command}\nDo not inspect or modify fixture code, fabricate its marker, or launch a substitute command.` : ""}` };
}

/** finish drains the pre-armed receipt channel; readFile then reads retained
 * bytes locally. Never snapshot or issue a sandbox RPC after lease retirement. */
export async function readCopilotRemoteMarkerAfterRetirement(fixture: CopilotRemoteFixture, baseline: CopilotRemoteSnapshot, target: string, expected: string): Promise<boolean> {
  const receipt = await fixture.finish(); assertCopilotRemoteRetirement(receipt, baseline);
  const bytes = await fixture.readFile(target);
  return bytes.toString("utf8") === expected && receipt.targets[target]?.sha256 === `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
