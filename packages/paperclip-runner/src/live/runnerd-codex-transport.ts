import { RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";
import { codexExecutableReadOnlyRoots } from "../drivers/codex/codex-security-config.js";
import { isCanonicalProviderEventType } from "../provider-events.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
  CodexTraceInterpretation,
  CodexTransportProcessInfo,
} from "../drivers/codex/app-server-transport.js";
import { createSanitizedCodexEnvironment } from "../drivers/codex/app-server-transport.js";
import {
  codexSemanticToolSpecs,
  createIsolatedCodexAppServerArgs,
} from "../drivers/codex/codex-app-server-driver.js";
import type {
  DurableRecoveryCommittedEvent,
  DurableRecoveryIdentity,
} from "../contracts/durable-recovery.js";
import type { NativeRunIdentity } from "../contracts/types.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import type {
  HarnessRuntimeRequestResolution,
  PersistedHarnessProviderIdentity,
} from "../contracts/harness-driver.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  inspectWarmRunTransition,
  spawnRunner,
  waitForProcess,
  type RunnerProcessHandle,
  type RunnerProcessConnection,
  type RunnerProcessLaunchSpec,
  type DurablePrpControlPlaneOptions,
} from "../control-plane/durable-prp-control-plane.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";
import { createSanitizedAcpxSpawnInput } from "../drivers/acpx/environment.js";
import {
  createSanitizedAwsAgentCoreEnvironment,
  createSanitizedClaudeManagedEnvironment,
} from "../drivers/claude-managed/environment.js";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type {
  NativeAcpxPermissionMode,
  NativeOpenCodePermissionMode,
} from "../contracts/native-execution.js";
import { nativeMcpLaunchBinding } from "../drivers/native-mcp.js";
import {
  prepareIsolatedCodexHome,
  releaseMaterializedNativeRuntimeSkills,
} from "../drivers/runtime-context-materializer.js";
import { RUNNERD_CANONICAL_ITEM } from "../drivers/codex/codex-driver-values.js";

// URL directory conversion preserves a trailing separator while path-derived
// build artifacts do not. Normalize once so a source build cannot be
// misclassified as an external provider pack by a string-only comparison.
const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const MAX_NOTIFICATION_COUNT = 2_048;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const RUNNER_CLIENT_VERSION = "0.3.0";
const RUNNER_BOOTSTRAP_TICKET_TTL_MS = 60_000;
const RUNNERD_MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
const RUNNERD_P0_RESERVE_BYTES = 1024 * 1024;

function readLocalProcessStartedAt(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      return new Date(statSync(`/proc/${pid}`).ctimeMs).toISOString();
    }
    if (
      ["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(
        process.platform,
      )
    ) {
      const raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
      }).trim();
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (process.platform === "win32") {
      const script = [
        `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
        "$target.StartTime.ToUniversalTime().ToString('o')",
      ].join("; ");
      for (const command of ["powershell.exe", "pwsh.exe"]) {
        try {
          const raw = execFileSync(
            command,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", timeout: 1_500, windowsHide: true },
          ).trim();
          const parsed = new Date(raw);
          if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
        } catch {
          // Try the other supported PowerShell host.
        }
      }
    }
  } catch {
    // Process exit and restricted process metadata both produce no fingerprint.
  }
  return null;
}

const CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS = `## Codex-style collaboration

- Before the first tool call in a turn, send a brief commentary update describing the immediate work you are starting.
- During tool-driven work, send concise commentary updates at meaningful transitions so the user can follow progress without opening raw logs.
- Reserve \`report_progress\` for meaningful durable milestones on longer work. Do not call it merely to create a completion comment on a short run; Paperclip materializes the final assistant response as the durable completion comment.
- Invoke the semantic completion tool exactly once before the final assistant response. After it succeeds, send one self-contained final response with the outcome and verification, then do not call another tool. The completion tool records task disposition; Paperclip keeps receiving your answer until the provider turn ends.`;

export function withCodexCollaborationRuntimeInstructions(
  instructions: string,
  enabled = true,
): string {
  if (!enabled) return instructions;
  const base = instructions.trimEnd();
  return `${base}\n\n${CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS}`;
}

function readControlPlaneState(directory: string): Record<string, unknown> {
  const path = resolve(directory, "control-plane-state.json");
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 64 * 1024 * 1024
  ) {
    throw new Error("native_runner_control_plane_state_unsafe");
  }
  return record(JSON.parse(readFileSync(path, "utf8")));
}

function readRunnerState(path: string): Record<string, unknown> {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 16 * 1024 * 1024
  ) {
    throw new Error("native_runner_authority_rotation_state_unsafe");
  }
  return record(JSON.parse(readFileSync(path, "utf8")));
}

function controlPlaneIdentity(
  state: Record<string, unknown>,
): DurableRecoveryIdentity {
  return structuredClone(
    record(state.identity) as unknown as DurableRecoveryIdentity,
  );
}

function recoveryIdentityMatches(
  value: DurableRecoveryIdentity | Record<string, unknown>,
  expected: DurableRecoveryIdentity,
): boolean {
  return (
    value.runnerInstanceId === expected.runnerInstanceId &&
    value.environmentLeaseId === expected.environmentLeaseId &&
    value.runId === expected.runId &&
    value.normalizedSessionId === expected.normalizedSessionId &&
    value.turnId === expected.turnId &&
    value.itemId === expected.itemId
  );
}

function assertSuspendedRunnerState(
  state: Record<string, unknown>,
  expected: DurableRecoveryIdentity,
): void {
  if (
    state.schema !== "paperclip.runner.durable.state.v1" ||
    !recoveryIdentityMatches(state, expected) ||
    state.lifecycle !== "suspended"
  ) {
    throw new Error("native_runner_authority_rotation_requires_settled_state");
  }
}

function assertRealDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("native_runner_authority_archive_unsafe");
  }
}

function quarantineLocalRuntimeState(root: string, reason: unknown): never {
  assertRealDirectory(root);
  const quarantine = resolve(
    dirname(root),
    `${basename(root)}.quarantine-${randomUUID()}`,
  );
  renameSync(root, quarantine);
  mkdirSync(root, { mode: 0o700 });
  const detail = reason instanceof Error ? reason.message : String(reason);
  throw new Error(
    `native_runner_state_quarantined: ${detail}; the prior state was preserved for operator recovery`,
  );
}

function authorityArchiveDirectory(
  root: string,
  identity: DurableRecoveryIdentity,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
  return resolve(root, "authority-epochs", `epoch-${digest}`);
}

function latestArchivedControlPlaneState(
  root: string,
  desired: DurableRecoveryIdentity,
): Record<string, unknown> | null {
  const archivesRoot = resolve(root, "authority-epochs");
  if (!existsSync(archivesRoot)) return null;
  assertRealDirectory(archivesRoot);
  const candidates = readdirSync(archivesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => resolve(archivesRoot, entry.name, "control-plane"))
    .filter((directory) =>
      existsSync(resolve(directory, "control-plane-state.json")),
    )
    .map((directory) => ({
      directory,
      modifiedAt: statSync(resolve(directory, "control-plane-state.json"))
        .mtimeMs,
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates) {
    assertRealDirectory(candidate.directory);
    const state = readControlPlaneState(candidate.directory);
    const identity = controlPlaneIdentity(state);
    if (
      identity.runnerInstanceId === desired.runnerInstanceId &&
      identity.environmentLeaseId === desired.environmentLeaseId &&
      identity.normalizedSessionId === desired.normalizedSessionId
    ) {
      return state;
    }
  }
  return null;
}

function rotateLocalAuthorityEpoch(
  root: string,
  controlPlaneState: Record<string, unknown>,
  desired: DurableRecoveryIdentity,
): Record<string, unknown> {
  const priorIdentity = controlPlaneIdentity(controlPlaneState);
  if (
    priorIdentity.runnerInstanceId !== desired.runnerInstanceId ||
    priorIdentity.environmentLeaseId !== desired.environmentLeaseId ||
    priorIdentity.normalizedSessionId !== desired.normalizedSessionId ||
    priorIdentity.runId === desired.runId
  ) {
    throw new Error(
      "PRP recovery identity does not match the durable session binding",
    );
  }
  const runnerDirectory = resolve(root, "runner");
  const runnerStatePath = resolve(runnerDirectory, "runner-state.json");
  const archive = authorityArchiveDirectory(root, priorIdentity);
  const archivedControlPlane = resolve(archive, "control-plane");
  const archivedRunnerState = resolve(archive, "runner-state.json");
  const runnerStateSource = existsSync(runnerStatePath)
    ? runnerStatePath
    : archivedRunnerState;
  if (!existsSync(runnerStateSource)) {
    throw new Error("native_runner_authority_rotation_state_unavailable");
  }
  assertRealDirectory(runnerDirectory);
  const runnerState = readRunnerState(runnerStateSource);
  if (
    runnerState.runnerInstanceId !== priorIdentity.runnerInstanceId ||
    runnerState.environmentLeaseId !== priorIdentity.environmentLeaseId ||
    runnerState.runId !== priorIdentity.runId ||
    runnerState.normalizedSessionId !== priorIdentity.normalizedSessionId ||
    runnerState.turnId !== priorIdentity.turnId ||
    runnerState.itemId !== priorIdentity.itemId ||
    runnerState.lifecycle !== "suspended"
  ) {
    throw new Error("native_runner_authority_rotation_requires_settled_state");
  }
  const archivesRoot = resolve(root, "authority-epochs");
  if (existsSync(archivesRoot)) {
    assertRealDirectory(archivesRoot);
  } else {
    mkdirSync(archivesRoot, { mode: 0o700 });
  }
  if (existsSync(archive)) {
    assertRealDirectory(archive);
  } else {
    mkdirSync(archive, { mode: 0o700 });
  }
  assertRealDirectory(archive);
  const activeControlPlane = resolve(root, "control-plane");
  if (existsSync(activeControlPlane)) {
    assertRealDirectory(activeControlPlane);
    if (existsSync(archivedControlPlane)) {
      throw new Error("native_runner_authority_archive_conflict");
    }
    renameSync(activeControlPlane, archivedControlPlane);
  }
  if (existsSync(runnerStatePath)) {
    if (existsSync(archivedRunnerState)) {
      throw new Error("native_runner_authority_archive_conflict");
    }
    renameSync(runnerStatePath, archivedRunnerState);
  }
  if (!existsSync(archivedControlPlane) || !existsSync(archivedRunnerState)) {
    throw new Error("native_runner_authority_archive_incomplete");
  }
  return controlPlaneState;
}

async function rotateExternalAuthorityEpoch(
  root: string,
  controlPlaneState: Record<string, unknown>,
  desired: DurableRecoveryIdentity,
  readRunnerState: () => Promise<Record<string, unknown>>,
  archiveRunnerState: (input: {
    archiveKey: string;
    priorIdentity: DurableRecoveryIdentity;
  }) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const priorIdentity = controlPlaneIdentity(controlPlaneState);
  if (
    priorIdentity.runnerInstanceId !== desired.runnerInstanceId ||
    priorIdentity.environmentLeaseId !== desired.environmentLeaseId ||
    priorIdentity.normalizedSessionId !== desired.normalizedSessionId ||
    priorIdentity.runId === desired.runId
  ) {
    throw new Error(
      "PRP recovery identity does not match the durable session binding",
    );
  }
  const archive = authorityArchiveDirectory(root, priorIdentity);
  const archivedControlPlane = resolve(archive, "control-plane");
  const activeControlPlane = resolve(root, "control-plane");
  const archivesRoot = resolve(root, "authority-epochs");
  if (existsSync(archivesRoot)) {
    assertRealDirectory(archivesRoot);
  } else {
    mkdirSync(archivesRoot, { mode: 0o700 });
  }
  if (existsSync(archive)) {
    assertRealDirectory(archive);
  } else {
    mkdirSync(archive, { mode: 0o700 });
  }
  assertRealDirectory(archive);
  if (existsSync(archivedControlPlane)) {
    // This directory is the durable transaction marker. A prior controller
    // may have stopped before or after the remote move, so resume the same
    // idempotent archive instead of starting a new external runner.
    assertRealDirectory(archivedControlPlane);
    if (existsSync(activeControlPlane)) {
      throw new Error("native_runner_authority_archive_conflict");
    }
    const archivedIdentity = controlPlaneIdentity(
      readControlPlaneState(archivedControlPlane),
    );
    if (!recoveryIdentityMatches(archivedIdentity, priorIdentity)) {
      throw new Error("native_runner_authority_archive_conflict");
    }
  } else {
    const runnerState = await readRunnerState();
    assertSuspendedRunnerState(runnerState, priorIdentity);
    assertRealDirectory(activeControlPlane);
    renameSync(activeControlPlane, archivedControlPlane);
  }
  const archivedRunnerState = await archiveRunnerState({
    archiveKey: basename(archive).replace(/^epoch-/, ""),
    priorIdentity,
  });
  assertSuspendedRunnerState(archivedRunnerState, priorIdentity);
  return controlPlaneState;
}

function rotatedRunAttachPayload(
  state: { commands?: unknown; runAttachTemplate?: unknown },
  desired: DurableRecoveryIdentity,
  authorizedTools: Record<string, unknown> | null,
  completionContract:
    { revision: string; criterionIds: readonly string[] } | undefined,
): Record<string, unknown> {
  const commands = Array.isArray(state.commands)
    ? state.commands.map(record)
    : [];
  const persistedTemplate =
    state.runAttachTemplate !== null &&
    typeof state.runAttachTemplate === "object" &&
    !Array.isArray(state.runAttachTemplate)
      ? (state.runAttachTemplate as Record<string, unknown>)
      : null;
  const commandSeed = [...commands]
    .reverse()
    .find(
      (command) =>
        (command.type === "run.prepare" || command.type === "run.attach") &&
        record(command.payload).provider !== undefined,
    );
  const seed = persistedTemplate ?? record(commandSeed?.payload);
  if (seed.provider === undefined)
    throw new Error("native_runner_authority_rotation_seed_unavailable");
  return retargetRunAttachPayload(
    seed,
    desired,
    authorizedTools,
    completionContract,
  );
}

function retargetRunAttachPayload(
  seedPayload: Record<string, unknown>,
  desired: DurableRecoveryIdentity,
  authorizedTools: Record<string, unknown> | null,
  completionContract:
    { revision: string; criterionIds: readonly string[] } | undefined,
): Record<string, unknown> {
  const payload = structuredClone(seedPayload);
  const provider = record(payload.provider);
  if (provider.kind === "acpx" || provider.provider === "acpx") {
    provider.runId = desired.runId;
    provider.normalizedSessionId = desired.normalizedSessionId;
    payload.provider = provider;
  }
  if (authorizedTools !== null) payload.authorizedTools = authorizedTools;
  if (completionContract !== undefined) {
    payload.completionContract = {
      revision: completionContract.revision,
      criterionIds: [...completionContract.criterionIds],
    };
  }
  return payload;
}

function recoveredRunAttachment(state: {
  commands: readonly {
    commandId: string;
    type: string;
    status: string;
  }[];
  committedEvents: readonly { eventType: string }[];
}): {
  commandId: string;
  status: string;
  providerIdentityEventIndex: number;
} | null {
  const command = [...state.commands]
    .reverse()
    .find((candidate) => candidate.type === "run.attach");
  if (!command) return null;
  const providerIdentityEventIndex =
    command.status === "completed"
      ? latestProviderIdentityEventIndex(state.committedEvents)
      : -1;
  return {
    commandId: command.commandId,
    status: command.status,
    providerIdentityEventIndex,
  };
}

function latestProviderIdentityEventIndex(
  events: readonly { eventType: string }[],
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const eventType = events[index]?.eventType;
    if (
      eventType === "harness.ready" ||
      eventType === "session.started" ||
      eventType === "session.resumed"
    ) {
      return index;
    }
  }
  return -1;
}

function providerDrainStateFromSnapshot(state: Record<string, unknown>): {
  pendingEventCount: number;
  activeProviderTurnId: string | null;
  providerSettled: boolean;
} {
  if (
    !Array.isArray(state.pendingEvents) ||
    (state.queuedEvents !== undefined && !Array.isArray(state.queuedEvents)) ||
    [state.activeProviderTurnId, state.activeTurnId].some(
      (value) =>
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.length === 0),
    ) ||
    (state.ambiguousTurnStartPending !== undefined &&
      typeof state.ambiguousTurnStartPending !== "boolean")
  )
    throw new Error("Provider drain state is malformed.");
  const pending = Array.isArray(state.pendingEvents)
    ? state.pendingEvents.length
    : 0;
  const queued = Array.isArray(state.queuedEvents)
    ? state.queuedEvents.length
    : 0;
  const activeProviderTurnId =
    [state.activeProviderTurnId, state.activeTurnId].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? null;
  return {
    pendingEventCount: pending + queued,
    activeProviderTurnId,
    providerSettled:
      activeProviderTurnId === null && state.ambiguousTurnStartPending !== true,
  };
}

type ProviderDrainState =
  ReturnType<typeof providerDrainStateFromSnapshot> | "unreadable" | null;

async function awaitProviderDrainBarrier(input: {
  readProviderState: () => ProviderDrainState;
  semanticResultsSettled: () => boolean;
  commands: () => readonly {
    commandId: string;
    status: string;
    result?: unknown;
  }[];
  queueDrain: (commandId: string) => void;
  pump: () => void;
  deadline: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  let receiptConfirmed = false;
  while (Date.now() < input.deadline) {
    input.pump();
    // A callback is not part of the provider FIFO until its result is durably
    // queued and completed. Never certify a temporarily empty prefix while
    // that admitted old-authority result is still being produced.
    if (!input.semanticResultsSettled()) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, input.pollIntervalMs ?? 5),
      );
      continue;
    }
    const state = input.readProviderState();
    // Remote roots still require the exact runner-owned receipt. Their
    // checkpoint separately verifies provider settlement on the remote host.
    if (
      receiptConfirmed &&
      (state === null ||
        (state !== "unreadable" &&
          state.pendingEventCount === 0 &&
          state.providerSettled))
    )
      return true;
    if (state === "unreadable") {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, input.pollIntervalMs ?? 5),
      );
      continue;
    }
    const commandId = `command_close_drain_${randomUUID().replaceAll("-", "")}`;
    input.queueDrain(commandId);
    while (Date.now() < input.deadline) {
      input.pump();
      const command = input
        .commands()
        .find((candidate) => candidate.commandId === commandId);
      if (command?.status === "completed") {
        const proof = record(
          record(command.result).result,
        ).retainedEventsDrained;
        // Older runners and malformed/truthy values cannot certify closure.
        if (typeof proof !== "boolean") return false;
        receiptConfirmed = proof;
        break;
      }
      if (command !== undefined && command.status !== "pending") return false;
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, input.pollIntervalMs ?? 5),
      );
    }
  }
  return false;
}

function providerTurnIsActiveFromCommittedEvents(
  events: readonly { eventType: string }[],
): boolean {
  let active = false;
  for (const event of events) {
    if (event.eventType === "turn.started") active = true;
    else if (
      event.eventType === "turn.completed" ||
      event.eventType === "turn.failed" ||
      event.eventType === "turn.interrupted" ||
      event.eventType === "turn.cancelled"
    ) {
      active = false;
    }
  }
  return active;
}

function turnStartResponseReady(input: {
  responseEpoch: number;
  observedEpoch: number;
  expectedProviderTurnId: string;
  boundTurnId: string;
}): boolean {
  return (
    input.responseEpoch === input.observedEpoch &&
    input.expectedProviderTurnId.length > 0 &&
    input.boundTurnId === input.expectedProviderTurnId
  );
}

function turnStartNotificationDisposition(input: {
  responsePending: boolean;
  expectedProviderTurnId: string | null;
  observedProviderTurnId: string;
}): "accept" | "defer" | "reject" {
  if (!input.responsePending) return "accept";
  if (input.expectedProviderTurnId === null) return "defer";
  return input.observedProviderTurnId === input.expectedProviderTurnId
    ? "accept"
    : "reject";
}

function turnStartCommandResultValid(input: {
  requestedTurnId: string;
  providerTurnId: string;
  requireRequestedIdentity: boolean;
}): boolean {
  return (
    input.requestedTurnId.length > 0 &&
    input.providerTurnId.length > 0 &&
    (!input.requireRequestedIdentity ||
      input.providerTurnId === input.requestedTurnId)
  );
}

async function releaseRunnerProcessOwnership(input: {
  runnerSettled: boolean;
  checkpoint:
    ((settlement: "settled" | "unsettled") => Promise<void> | void) | null;
  forceKill: () => void;
  release: (() => Promise<void> | void) | null;
}): Promise<void> {
  let releaseFailure: unknown;
  try {
    if (input.release !== null) await input.release();
  } catch (error) {
    releaseFailure = error;
  }
  let checkpointFailure: unknown;
  try {
    if (input.checkpoint !== null) {
      // Release only the authenticated control route first. In provider-ingress
      // mode this stops its reconnect loop; it does not release the sandbox
      // lease or the runner process owner. The bounded process wait above may
      // observe the remote exec before this route has fully quiesced, while the
      // exact durable state becomes readable only after it has. Keep the
      // independently verified checkpoint ahead of process containment.
      await input.checkpoint(input.runnerSettled ? "settled" : "unsettled");
    }
  } catch (error) {
    checkpointFailure = error;
  } finally {
    input.forceKill();
  }
  if (checkpointFailure !== undefined) throw checkpointFailure;
  if (releaseFailure !== undefined) throw releaseFailure;
}

async function awaitRunnerSuspensionBarrier(input: {
  commands: () => readonly {
    commandId: string;
    type: string;
    status: string;
  }[];
  queueSuspend: (commandId: string) => void;
  readRunnerState: () => Promise<Record<string, unknown>>;
  runnerHasExited: () => Promise<boolean>;
  pump: () => void;
  deadline: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  let existing = [...input.commands()]
    .reverse()
    .find(
      (command) =>
        command.type === "runner.suspend" &&
        (command.status === "pending" || command.status === "completed"),
    );
  if (existing?.status === "completed") {
    // A retained authority may have resumed since this command completed.
    // Reuse its receipt only when the current exact durable state is already
    // suspended; otherwise issue a new command rather than waiting on history.
    try {
      if ((await input.readRunnerState()).lifecycle === "suspended")
        return Date.now() < input.deadline;
    } catch {
      // The normal bounded barrier below handles unavailable state.
    }
    existing = undefined;
  }
  const commandId =
    existing?.commandId ??
    `command_close_suspend_${randomUUID().replaceAll("-", "")}`;
  if (!existing) input.queueSuspend(commandId);

  while (Date.now() < input.deadline) {
    input.pump();
    const command = input
      .commands()
      .find((candidate) => candidate.commandId === commandId);
    if (
      command !== undefined &&
      command.status !== "pending" &&
      command.status !== "completed"
    ) {
      return false;
    }
    let lifecycle: unknown;
    try {
      lifecycle = (await input.readRunnerState()).lifecycle;
    } catch {
      // A remote filesystem can lag the command-result delivery by a small
      // amount. Keep the single close deadline as the fail-closed bound.
    }
    if (
      command?.status === "completed" &&
      lifecycle === "suspended" &&
      Date.now() < input.deadline
    ) {
      return true;
    }
    // Process completion alone is not a suspension proof. The durable state
    // write precedes the terminal command result and process exit, so allow
    // either observation to arrive first while staying within the same bound.
    await input.runnerHasExited();
    await new Promise<void>((resolveWait) =>
      setTimeout(resolveWait, input.pollIntervalMs ?? 10),
    );
  }
  return false;
}

function runnerCloseDeadlines(
  startedAtMs: number,
  graceMs: number,
): {
  preparationDeadline: number;
  closeDeadline: number;
} {
  // Stopping a still-finishing provider and draining its suffix are best-effort
  // preparation. Neither may consume the entire budget and enqueue suspend
  // immediately before force-killing the runner. The suspension proof itself
  // must retain a finite opportunity to cross the durable command boundary.
  const suspensionReserveMs = Math.min(2_500, Math.ceil(graceMs / 2));
  return {
    preparationDeadline: startedAtMs + graceMs - suspensionReserveMs,
    closeDeadline: startedAtMs + graceMs,
  };
}

async function awaitAdoptedRunnerAuthentication(input: {
  activeConnectionCount: () => number;
  isAlive: () => Promise<boolean> | boolean;
  throwIfFailed: () => void;
  failure: Promise<never>;
  ready?: () => Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("runnerReconnectGraceMs must be a positive safe integer");
  }
  const deadline = Date.now() + input.timeoutMs;
  const timeoutError = () =>
    new Error(
      "native_adopted_runner_authentication_timeout: the existing runner did not authenticate within " +
        `${input.timeoutMs}ms; preserve its process and durable session for operator recovery`,
    );
  let cancelled = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw timeoutError();
  };
  const observe = async () => {
    await input.ready?.();
    while (!cancelled) {
      input.throwIfFailed();
      checkDeadline();
      if (input.activeConnectionCount() === 1) return;
      const alive = await input.isAlive();
      if (cancelled) return;
      input.throwIfFailed();
      checkDeadline();
      if (!alive) {
        throw new Error(
          "native_adopted_runner_exited: runner exited before PRP authentication",
        );
      }
      if (input.activeConnectionCount() === 1) return;
      await new Promise<void>((resolveWait) => {
        pollTimer = setTimeout(
          resolveWait,
          Math.min(25, deadline - Date.now()),
        );
      });
    }
  };
  try {
    await Promise.race([
      observe(),
      input.failure,
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(
          () => reject(timeoutError()),
          input.timeoutMs,
        );
      }),
    ]);
  } finally {
    cancelled = true;
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
  }
}

function bridgedCodexQuestionParams(
  request: Record<string, unknown>,
  method: string,
  threadId: string,
  turnId: string,
): Record<string, unknown> | null {
  const questionSet = record(request.input);
  if (
    questionSet.schema !== "paperclip.question_set.v1" ||
    !Array.isArray(questionSet.questions) ||
    questionSet.questions.length === 0
  )
    return null;
  const common = {
    threadId,
    turnId,
    itemId:
      typeof request.itemId === "string"
        ? request.itemId
        : String(request.requestId ?? "runtime-input"),
  };
  if (method === "mcpServer/elicitation/request") {
    const required: string[] = [];
    const properties = Object.fromEntries(
      questionSet.questions.map((candidate, index) => {
        const question = record(candidate);
        const id =
          typeof question.id === "string"
            ? question.id
            : `question-${index + 1}`;
        if (question.required === true) required.push(id);
        const validation = record(question.textValidation);
        const options = Array.isArray(question.options)
          ? question.options.map((candidateOption) => {
              const option = record(candidateOption);
              return {
                const: typeof option.id === "string" ? option.id : "option",
                title:
                  typeof option.label === "string" ? option.label : "Option",
                ...(typeof option.description === "string"
                  ? { description: option.description }
                  : {}),
              };
            })
          : [];
        const isBoolean =
          question.answerMode === "single_select" &&
          options.length === 2 &&
          options[0]?.const === "true" &&
          options[1]?.const === "false";
        const inputType =
          validation.inputType === "integer" ||
          validation.inputType === "number"
            ? validation.inputType
            : "string";
        const scalarSchema = isBoolean
          ? { type: "boolean" }
          : options.length > 0
            ? { type: "string", oneOf: options }
            : {
                type: inputType,
                ...(typeof validation.minLength === "number"
                  ? { minLength: validation.minLength }
                  : {}),
                ...(typeof validation.maxLength === "number"
                  ? { maxLength: validation.maxLength }
                  : {}),
                ...(typeof validation.minimum === "number"
                  ? { minimum: validation.minimum }
                  : {}),
                ...(typeof validation.maximum === "number"
                  ? { maximum: validation.maximum }
                  : {}),
                ...(typeof validation.pattern === "string"
                  ? { pattern: validation.pattern }
                  : {}),
              };
        return [
          id,
          {
            ...(question.answerMode === "multi_select"
              ? { type: "array", items: scalarSchema }
              : scalarSchema),
            ...(typeof question.header === "string"
              ? { title: question.header }
              : typeof question.prompt === "string"
                ? { title: question.prompt }
                : {}),
            ...(typeof question.helpText === "string"
              ? { description: question.helpText }
              : {}),
          },
        ];
      }),
    );
    return {
      ...common,
      message:
        typeof questionSet.description === "string"
          ? questionSet.description
          : typeof questionSet.title === "string"
            ? questionSet.title
            : "A tool needs your input",
      requestedSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  }
  return {
    ...common,
    ...(typeof questionSet.title === "string"
      ? { title: questionSet.title }
      : {}),
    ...(typeof questionSet.description === "string"
      ? { description: questionSet.description }
      : {}),
    ...(typeof questionSet.submitLabel === "string"
      ? { submitLabel: questionSet.submitLabel }
      : {}),
    questions: questionSet.questions.map((candidate, index) => {
      const question = record(candidate);
      const validation = record(question.textValidation);
      return {
        id:
          typeof question.id === "string"
            ? question.id
            : `question-${index + 1}`,
        ...(typeof question.header === "string"
          ? { header: question.header }
          : {}),
        question:
          typeof question.prompt === "string"
            ? question.prompt
            : `Question ${index + 1}`,
        ...(typeof question.helpText === "string"
          ? { description: question.helpText }
          : {}),
        required: question.required === true,
        ...(question.answerMode === "multi_select"
          ? { multiSelect: true }
          : {}),
        ...(Array.isArray(question.options)
          ? {
              options: question.options.map((candidateOption, optionIndex) => {
                const option = record(candidateOption);
                return {
                  id:
                    typeof option.id === "string"
                      ? option.id
                      : `option-${optionIndex + 1}`,
                  label:
                    typeof option.label === "string"
                      ? option.label
                      : `Option ${optionIndex + 1}`,
                  ...(typeof option.description === "string"
                    ? { description: option.description }
                    : {}),
                };
              }),
            }
          : {}),
        ...(record(question.customAnswer).enabled === true
          ? { isOther: true }
          : {}),
        ...(typeof validation.minLength === "number"
          ? { minLength: validation.minLength }
          : {}),
        ...(typeof validation.maxLength === "number"
          ? { maxLength: validation.maxLength }
          : {}),
      };
    }),
  };
}

export interface CapabilityRunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  providerPid: number | null;
  providerProcessStartedAt: string | null;
  codexPid: number | null;
  codexProcessStartedAt: string | null;
  sidecarPid: number | null;
  sidecarProcessStartedAt: string | null;
  agentPid: number | null;
  agentProcessStartedAt: string | null;
  providerDriver: string | null;
  providerVersion: string | null;
  acpxAgent: QualifiedAcpxAgent | null;
  agentServerVersion: string | null;
  agentRuntimeVersion: string | null;
  acpProtocolVersion: number | null;
  providerExecutionKind: "local_process" | "remote_service" | null;
  providerService:
    "anthropic_managed_agents" | "aws_bedrock_agentcore_harness" | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface CapabilityRunnerdCodexTransportOptions {
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  opencodePermissionMode?: NativeOpenCodePermissionMode;
  acpxAgent?: QualifiedAcpxAgent;
  acpxPermissionMode?: NativeAcpxPermissionMode;
  acpxPermissionModePinned?: boolean;
  acpxSidecarPath?: string;
  /** SHA-256 verified by the provider-pack authority before runner startup. */
  acpxSidecarSha256?: string;
  /** Node executable in the runner filesystem; required for remote JS providers. */
  providerNodeCommand?: string;
  /** SHA-256 verified by the provider-pack authority before runner startup. */
  providerNodeCommandSha256?: string;
  /** Digest of the build-owned provider-pack manifest that authorized remote artifacts. */
  providerPackAuthorityDigest?: string;
  acpxRuntimeDirectory?: string;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
    maxSessionListCostUsd: number;
    model: string;
  };
  agentCoreProfile?: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: 90;
    maxEstimatedSessionCostUsd: number;
    maxIterations: number;
    maxOutputTokens: number;
    timeoutSeconds: number;
    model: string;
  };
  runnerBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  /** Controller-visible Codex home used only to seed the isolated runner home. */
  sourceCodexHome?: string | null;
  opencodeCommand?: string;
  /** SHA-256 verified by the provider-pack authority before runner startup. */
  opencodeCommandSha256?: string;
  opencodeProxyPath?: string;
  /** SHA-256 verified by the provider-pack authority before runner startup. */
  opencodeProxySha256?: string;
  opencodeRuntimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  /** Provider system instructions supplied by a native execution caller. */
  baseInstructions?: string;
  closeGraceMs?: number;
  /** Bounded provider turn-admission wait; defaults to 30 seconds. */
  turnStartTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<CapabilityRunnerdProcessEvidence>) => void;
  /** Persist process ownership immediately after spawn, before waiting for
   * provider bootstrap or activating a deferred PRP registration. */
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  stateDirectory?: string;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  /** Runtime-context paths rewritten for the runner-owned filesystem. */
  runnerRuntimeContext?: NativeRuntimeContextSnapshot | null;
  /** Root path visible to runnerd when it is not on the Paperclip host. */
  runnerFilesystemRoot?: string;
  /** Workspace cwd to retain when a local provider session is reopened. */
  resumeWorkingDirectory?: string;
  /**
   * The provider process is already confined by a sandbox execution target.
   * Codex must use its explicit external-sandbox policy because container
   * runtimes such as Daytona intentionally omit nested namespace privileges.
   */
  externallySandboxed?: boolean;
  /** Current run's authority catalog, used when a suspended session is rebound. */
  resumeDynamicTools?: readonly Readonly<Record<string, unknown>>[];
  /** Current run's completion authority, rebound without changing provider identity. */
  resumeCompletionContract?: {
    revision: string;
    criterionIds: readonly string[];
  };
  /** Provider turn recorded by the owner checkpoint when restoring an active run. */
  resumeActiveTurnId?: string | null;
  /**
   * Exact provider identity from the database checkpoint. A verified adopted
   * runner may use this when its original identity event has left the bounded
   * PRP replay window. Recovery remains blocked until an authenticated live
   * snapshot or a fresh identity event matches this checkpoint.
   */
  resumeProviderSession?: {
    driverSessionId: string;
    providerSessionId?: string | null;
    providerIdentity?: PersistedHarnessProviderIdentity;
  };
  /** Explicitly permits ACPX to rotate its provider-native session after a governed wait. */
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_resume_failure"
    | "allow_replacement_after_governed_wait";
  prpIdentity?: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
    normalizedSessionId: string;
    turnId: string;
    itemId: string;
  };
  /** Registers the run-bound PRP authority on Paperclip's shared HTTP server. */
  controlPlaneRegistration?: (
    authority: DurablePrpControlPlane,
    identity?: DurableRecoveryIdentity,
  ) => Promise<{
    connectUrl?: string;
    connection?: RunnerProcessConnection;
    activate?: () => Promise<void> | void;
    ready?: () => Promise<void>;
    failure?: Promise<never>;
    startupFailureCode?:
      | "runner_local_connect_failed"
      | "runner_direct_wss_failed"
      | "runner_ingress_unavailable";
    /** Persists only exact, independently verified suspended remote state. */
    checkpoint?: (settlement: "settled" | "unsettled") => Promise<void> | void;
    release: () => Promise<void> | void;
  }>;
  /** Existing server-owned routes only; never provision two ingress owners. */
  warmTransitionRegistrationMode?: "routed_connect";
  /** Rechecks the server-owned recovery claim after each asynchronous boundary. */
  authorizeWarmTransitionRecovery?: (
    stage: "before_bootstrap" | "before_spawn" | "before_authentication",
  ) => Promise<void>;
  /** Retires recovery-only caller fences after a fresh exact post-ACK snapshot. */
  onWarmTransitionRecoveryCompleted?: (input: {
    transitionId: string;
  }) => void | Promise<void>;
  /** Optional remote process owner used only by the new runner coordinator. */
  runnerProcessLauncher?: (
    spec: RunnerProcessLaunchSpec,
  ) => RunnerProcessHandle;
  /** Durable runner state path in the process owner's filesystem. */
  runnerStateDirectory?: string;
  /** Read the live durable runner state when runnerd owns a remote filesystem. */
  readRunnerState?: () => Promise<Record<string, unknown>>;
  /** Materializes a verified external checkpoint before authority rotation. */
  prepareExternalRunnerState?: () => Promise<void>;
  /** Idempotently archives and returns the verified suspended runner binding. */
  archiveExternalRunnerState?: (input: {
    archiveKey: string;
    priorIdentity: DurableRecoveryIdentity;
  }) => Promise<Record<string, unknown>>;
  /** Active-connection recovery budget. Omitted for the existing local mode. */
  runnerReconnectGraceMs?: number;
  /**
   * A verified local runner that outlived its controller. Adoption registers
   * the durable authority and waits for this exact process to reconnect; it
   * never calls the process launcher while the process remains alive.
   */
  adoptExistingRunner?: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
    isAlive: () => Promise<boolean> | boolean;
    signal?: (signal: NodeJS.Signals) => Promise<boolean> | boolean;
  };
}

export type RunnerdCodexTransportOptions =
  CapabilityRunnerdCodexTransportOptions;

export interface CapabilityRunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<CapabilityRunnerdProcessEvidence>;
  /** Relinquish controller authority without stopping the durable runner. */
  detachControllerForRestart(): Promise<void>;
}

export type RunnerdCodexTransport = CapabilityRunnerdCodexTransport;

export function unwrapRunnerdProviderNotifications(
  input: unknown,
): Record<string, unknown>[] {
  const payload = record(input);
  if (typeof payload.method === "string") return [payload];
  if (Array.isArray(payload.events)) {
    return payload.events
      .map(record)
      .filter((event) => typeof event.method === "string");
  }
  const latest = record(payload.latest);
  return typeof latest.method === "string" ? [latest] : [];
}

export function unwrapRunnerdProviderNotification(
  input: unknown,
): Record<string, unknown> {
  const notifications = unwrapRunnerdProviderNotifications(input);
  return notifications.at(-1) ?? record(input);
}

export function latestRunnerdSessionReadiness(
  events: readonly unknown[],
): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = record(events[index]);
    if (
      event.eventType !== "harness.ready" &&
      event.eventType !== "session.started" &&
      event.eventType !== "session.resumed"
    ) continue;
    return record(record(record(event.envelope).payload).payload);
  }
  return null;
}

export function unseenRunnerdCommittedEvents<
  T extends { sourceSeq: number },
>(events: readonly T[], lastSourceSeq: number): T[] {
  const unseen = events.filter((event) => event.sourceSeq > lastSourceSeq);
  if (unseen.length === 0) return [];
  let expectedSourceSeq = lastSourceSeq + 1;
  for (const event of unseen) {
    if (event.sourceSeq !== expectedSourceSeq) {
      throw new Error(
        `provider_notification_window_exceeded: expected source sequence ${expectedSourceSeq}, received ${event.sourceSeq}`,
      );
    }
    expectedSourceSeq += 1;
  }
  return unseen;
}

export function expandRunnerdCanonicalNotifications(
  method: string,
  input: unknown,
): Array<{ method: string; params: Record<string, unknown> }> {
  const payload = record(input);
  if (!Array.isArray(payload.events)) return [{ method, params: payload }];
  return payload.events.map((event) => ({ method, params: record(event) }));
}

export function runnerdCanonicalNotificationMethod(
  eventType: string,
  payload: Record<string, unknown>,
): string | undefined {
  // An empty open/resume snapshot is already returned by thread/goal/get and
  // is not a provider-side clear transition. Do not insert a synthetic clear
  // ahead of the first real turn notification.
  if (eventType === "session.goal.snapshot" && payload.goal === null) {
    return undefined;
  }
  return (
    {
      "turn.started": "turn/started",
      "item.started": "item/started",
      "item.delta": "item/agentMessage/delta",
      "item.completed": "item/completed",
      "turn.completed": "turn/completed",
      "turn.failed": "turn/completed",
      "turn.interrupted": "turn/completed",
      "turn.cancelled": "turn/completed",
      "usage.reported": "thread/tokenUsage/updated",
      "plan.updated": "turn/plan/updated",
      "workspace.change.updated": "paperclip/workspaceChange/updated",
      "run.result.proposed": "paperclip/runResult",
      "session.goal.snapshot": "thread/goal/updated",
      "session.goal.updated": "thread/goal/updated",
      "session.goal.cleared": "thread/goal/cleared",
      "session.updated":
        payload.status === "budget_reached"
          ? "provider/budgetReached"
          : "provider/sessionUpdated",
    } as Record<string, string>
  )[eventType];
}

export function resolveRunnerdSessionIdentity(input: unknown): {
  processId: number | null;
  threadId: string | null;
  sessionId: string | null;
} {
  const started = record(input);
  const runtimeIdentity = record(started.runtimeIdentity);
  const descriptor = record(started.providerDescriptor);
  const processId =
    runtimeIdentity.processId ??
    runtimeIdentity.process_id ??
    descriptor.processId ??
    started.processId ??
    started.pid;
  const threadId =
    started.threadId ?? started.driverSessionId ?? started.providerSessionId;
  const sessionId =
    started.sessionId ??
    started.providerAccountSessionId ??
    (started.driverSessionId === undefined
      ? undefined
      : started.providerSessionId);
  return {
    processId: typeof processId === "number" ? processId : null,
    threadId:
      typeof threadId === "string" && threadId.length > 0 ? threadId : null,
    sessionId:
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
  };
}

class NotificationQueue implements AsyncIterable<CodexRpcNotification> {
  #values: Array<{ value: CodexRpcNotification; bytes: number }> = [];
  #waiters: Array<{
    resolve: (value: IteratorResult<CodexRpcNotification>) => void;
    reject: (error: Error) => void;
  }> = [];
  #bytes = 0;
  #closed = false;
  #error: Error | null = null;

  push(value: CodexRpcNotification): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (
      this.#values.length >= MAX_NOTIFICATION_COUNT ||
      this.#bytes + bytes > MAX_NOTIFICATION_BYTES
    ) {
      throw new Error("PRP provider notification queue bound exceeded");
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    this.#values = [];
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error !== null) waiter.reject(this.#error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#bytes -= queued.bytes;
          return { value: queued.value, done: false };
        }
        if (this.#error !== null) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolveValue, reject) =>
          this.#waiters.push({ resolve: resolveValue, reject }),
        );
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function appServerThreadGoal(
  value: unknown,
  threadId: string,
): Record<string, unknown> | null {
  const goal = record(value);
  const objective = typeof goal.objective === "string"
    ? goal.objective.trim()
    : "";
  const rawStatus = typeof goal.status === "string" ? goal.status : "";
  const status = rawStatus === "usage_limited"
    ? "usageLimited"
    : rawStatus === "budget_limited"
      ? "budgetLimited"
      : rawStatus;
  if (
    objective.length === 0 ||
    ![
      "active",
      "paused",
      "blocked",
      "limited",
      "usageLimited",
      "budgetLimited",
      "complete",
    ].includes(status)
  ) return null;

  const epochSeconds = (timestamp: unknown): number => {
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return timestamp > 10_000_000_000 ? timestamp / 1_000 : timestamp;
    }
    if (typeof timestamp !== "string") return 0;
    const milliseconds = Date.parse(timestamp);
    return Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0;
  };

  return {
    threadId,
    objective,
    status,
    tokenBudget:
      typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds:
      typeof goal.timeUsedSeconds === "number"
        ? goal.timeUsedSeconds
        : typeof goal.elapsedSeconds === "number"
          ? goal.elapsedSeconds
          : 0,
    createdAt: epochSeconds(goal.createdAt),
    updatedAt: epochSeconds(goal.updatedAt),
  };
}

type PendingTraceRehydration = {
  sourceEventId: string;
  eventType: string;
  visibleNotificationCount: number;
};

type PendingDriverTraceInterpretation = CodexTraceInterpretation;

function appendRunnerdRehydrationTrace(
  index: RunnerdTraceFrameIndex,
  tracePath: string | undefined,
  sourceEventId: string,
  eventType: string,
  visibleNotificationCount: number,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = index.locate(
      tracePath,
      sourceEventId,
    );
    if (frameId === null)
      return nativeChannelSettled ? "not_applicable" : "retry";
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_runnerd_rehydration",
        ruleId: `runnerd.rehydrate.${eventType}`,
        sourceEventId,
        sourceEventType: eventType,
        disposition: visibleNotificationCount > 0 ? "mapped" : "ignored",
        emittedEventIds: visibleNotificationCount > 0 ? [sourceEventId] : [],
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "sourceEventId",
            outputPath: "paperclipTrace.sourceEventId",
            action: "copied",
            reason:
              "Preserved the durable event identity while rehydrating the provider notification",
          },
          {
            inputPath: "eventType",
            outputPath: "paperclipTrace.sourceEventType",
            action: "renamed",
            reason:
              "Attached the canonical PRP type to the rehydrated notification",
          },
        ],
        reason:
          visibleNotificationCount > 0
            ? "Canonical PRP event was rehydrated into the Codex driver notification contract"
            : "Canonical PRP event did not produce a Codex driver notification",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendCodexDriverInterpretationTrace(
  index: RunnerdTraceFrameIndex,
  tracePath: string | undefined,
  input: PendingDriverTraceInterpretation,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = index.locate(
      tracePath,
      input.sourceEventId,
    );
    if (frameId === null) {
      return nativeChannelSettled ? "not_applicable" : "retry";
    }
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_codex_driver_normalization",
        ruleId: `codex_driver.normalize.${input.providerMethod}`,
        sourceEventId: input.sourceEventId,
        sourceEventType: input.sourceEventType,
        disposition: input.disposition,
        emittedEventIds: input.emittedEventIds,
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "params",
            outputPath: "payload",
            action: "normalized",
            reason:
              "Codex notification fields were normalized into canonical PRP event payloads",
          },
          ...input.emittedEventIds.map((eventId) => ({
            outputPath: `event:${eventId}`,
            action: "derived",
            reason:
              "The driver emitted this canonical PRP event from the normalized notification",
          })),
        ],
        reason: input.reason,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendRunnerdTraceStatus(
  tracePath: string,
  input: {
    status: "complete" | "incomplete";
    reason: string | null;
    debugSequence: number;
    acknowledgedDebugSequence: number;
  },
): void {
  appendFileSync(
    `${tracePath}.rehydration`,
    `${JSON.stringify({
      kind: "trace_status",
      debugChannel: "typescript_runnerd_rehydration",
      debugSequence: input.debugSequence,
      status: input.status,
      acknowledgedDebugSequence: input.acknowledgedDebugSequence,
      reason: input.reason,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function rehydrateRunnerdUsageNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  return {
    ...rawParams,
    // The normalized PRP usage event carries the provider session identity
    // rather than replaying the provider's original threadId field. Rehydrate
    // the Codex notification contract so the strict driver does not reject
    // valid accounting as a cross-thread event.
    // The strict facade is opened on the runner-owned harness thread. A
    // providerSessionId can be a distinct backend/agent session (ACPX is one
    // example), so it must remain metadata rather than become a thread bind.
    threadId: openedThreadId,
    turnId: activeTurnId,
    tokenUsage: {
      total: record(rawParams.cumulative),
      runDelta: record(rawParams.runDelta),
    },
  };
}

export function rehydrateRunnerdThreadTokenUsage(
  cumulative: unknown,
): { total: Record<string, unknown> } | null {
  const total = record(cumulative);
  return Object.keys(total).length === 0 ? null : { total };
}

export function rehydrateRunnerdResultNotification(
  result: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
  itemId: string,
): Record<string, unknown> {
  return {
    threadId: openedThreadId,
    // The durable controller turn belongs to the runner envelope, while a
    // protocol facade may expose a different provider-native turn. The result
    // is observed during the latter and must be bound to that active turn.
    turnId: activeTurnId,
    itemId,
    result,
  };
}

export function rehydrateRunnerdTurnNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
  method: "turn/started" | "turn/completed",
): Record<string, unknown> {
  const rawTurn = record(rawParams.turn);
  const providerTurnId =
    typeof rawParams.providerTurnId === "string" &&
    rawParams.providerTurnId.length > 0
      ? rawParams.providerTurnId
      : null;
  const rawTurnId =
    providerTurnId ??
    (typeof rawTurn.id === "string" && rawTurn.id.length > 0
      ? rawTurn.id
      : typeof rawParams.turnId === "string" && rawParams.turnId.length > 0
        ? rawParams.turnId
        : activeTurnId);
  const boundTurnId =
    method === "turn/completed" ? (providerTurnId ?? activeTurnId) : rawTurnId;
  return {
    ...rawParams,
    // A canonical runnerd terminal is bound by the authenticated PRP envelope.
    // Its compact `turn.id` is the durable controller turn, not necessarily the
    // provider turn exposed by the Codex facade. Restore both strict bindings.
    threadId: openedThreadId,
    turnId: boundTurnId,
    turn: {
      ...rawTurn,
      id: boundTurnId,
      ...(rawTurn.status === undefined && rawParams.status !== undefined
        ? { status: rawParams.status }
        : {}),
      ...(rawTurn.error === undefined && rawParams.error !== undefined
        ? { error: rawParams.error }
        : {}),
    },
  };
}

export function rehydrateRunnerdDeltaNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  // Canonical PRP events already passed runner identity validation. Restore the
  // provider binding just as for item starts/completions; the PRP controller
  // turn is deliberately different from the provider's turn ID.
  return {
    ...rawParams,
    threadId: openedThreadId,
    turnId: activeTurnId,
    delta: rawParams.delta ?? rawParams.text,
  };
}

export function rehydrateRunnerdItemNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  const rawItem = record(rawParams.item);
  const channel = rawItem.channel ?? rawParams.channel;
  const providerPhase = rawItem.phase ?? rawParams.providerPhase;
  const phase =
    providerPhase ??
    (channel === "final"
      ? "final_answer"
      : channel === "progress"
        ? "commentary"
        : undefined);
  return {
    ...rawParams,
    threadId: openedThreadId,
    turnId: activeTurnId,
    item: {
      ...rawItem,
      [RUNNERD_CANONICAL_ITEM]: true,
      id: rawItem.id ?? rawParams.itemId,
      type: rawItem.type ?? rawParams.kind,
      status: rawItem.status ?? rawParams.status,
      text: rawItem.text ?? rawParams.text,
      ...(phase === undefined ? {} : { phase }),
      ...(channel === undefined ? {} : { channel }),
    },
  };
}

export function rehydrateRunnerdPlanNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  const steps = Array.isArray(rawParams.steps) ? rawParams.steps : [];
  return {
    ...rawParams,
    threadId: openedThreadId,
    turnId: activeTurnId,
    // Rust has already normalized the provider's plan entries into PRP's
    // { stepId, body, status } shape. Rebuild Codex's notification contract
    // so the strict TypeScript driver can perform (and expose) its second
    // interpretation stage instead of silently dropping the plan.
    plan: Array.isArray(rawParams.plan)
      ? rawParams.plan
      : steps.map((value) => {
          const step = record(value);
          return {
            step: typeof step.body === "string" ? step.body : "",
            status: typeof step.status === "string" ? step.status : "pending",
          };
        }),
  };
}

export function rehydrateRunnerdWorkspaceChangeNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  return {
    threadId: openedThreadId,
    turnId: activeTurnId,
    // Rust already parsed and bounded the complete Codex turn snapshot. Keep
    // that canonical value intact instead of consulting git or the workspace
    // again in the TypeScript driver.
    workspaceChange: structuredClone(rawParams),
  };
}

export function rehydrateRunnerdGoalNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  method: "thread/goal/updated" | "thread/goal/cleared",
): Record<string, unknown> {
  if (method === "thread/goal/cleared") {
    return { ...rawParams, threadId: openedThreadId };
  }
  return {
    ...rawParams,
    threadId: openedThreadId,
    goal: appServerThreadGoal(rawParams.goal, openedThreadId),
  };
}

function commandDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(durableRecoveryInternals.canonicalJson(value)).digest("hex")}`;
}

function approvedRunnerArtifact(runnerBinaryPath: string): {
  version: string;
  digest: string;
} {
  return {
    version: RUNNER_CLIENT_VERSION,
    digest: `sha256:${createHash("sha256")
      .update(readFileSync(runnerBinaryPath))
      .digest("hex")}`,
  };
}

/** Reads the caller-selected artifact binding; does not approve or execute it. */
export function readRunnerdArtifactBinding(runnerBinaryPath: string): {
  version: string;
  digest: string;
} {
  return approvedRunnerArtifact(runnerBinaryPath);
}

export interface RetainedRunnerdCleanupProof {
  readonly binding: Readonly<NativeRunIdentity>;
  readonly identity: Readonly<DurableRecoveryIdentity>;
  readonly backend: Readonly<{ kind: string; name: string }>;
  readonly providerSessionId: string;
  readonly activationDirectory: string;
  readonly sourceFingerprint: string;
  readonly settledFingerprint: string;
}

/** Content-free evidence for this controller's exact child handle. A launch
 * intent without a matching retirement is deliberately not absence proof. */
export type RetainedRunnerdMaintenanceEpochReceipt = {
  schema: "paperclip.native_cleanup_runner_epoch.v1";
  requestId: string;
  epoch: number;
  launchId: string;
  stateDirectory: string;
  initialFingerprint: string;
  runnerArtifact: { path: string; version: string; digest: string };
} & (
  | { phase: "launch_intent" }
  | {
      phase: "spawned";
      pid: number;
      processGroupId: number;
      processStartedAt: string;
      spawnedAt: string;
    }
  | {
      phase: "retired";
      pid: number;
      processGroupId: number;
      processStartedAt: string;
      spawnedAt: string;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      processGroupAbsent: true;
      retiredAt: string;
      finalFingerprint: string;
    }
);

const retainedRunnerdCleanupProofs = new WeakMap<object, readonly number[]>();
const retainedMaintenanceOperations = new Map<string, Set<Promise<unknown>>>();
const activeMaintenanceRoots = new Set<string>();

/** No absence claim about an old child; only this controller's joined work. */
export function retainedRunnerdMaintenanceIsIdle(directory: string): boolean {
  const root = resolve(directory);
  return !activeMaintenanceRoots.has(root) && !retainedMaintenanceOperations.has(root);
}

/** A timeout revokes cleanup authority, not ownership of an already-started
 * callback. Shutdown must join the original operations, including any that
 * another retained callback registers while the current snapshot settles. */
export async function drainRetainedRunnerdMaintenanceOperations(): Promise<void> {
  while (retainedMaintenanceOperations.size > 0) {
    await Promise.allSettled(
      [...retainedMaintenanceOperations.values()].flatMap((operations) => [
        ...operations,
      ]),
    );
  }
}

const MAINTENANCE_STATE_FILES = [
  "control-plane/control-plane-state.json",
  "runner/runner-state.json",
  "runner/codex-provider-state.json",
] as const;

function maintenanceDenied(): Error {
  return new Error("native_cleanup_maintenance_unproven");
}

function maintenanceProcessAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32")
    return false;
  return [pid, -pid].every((target) => {
    try {
      process.kill(target, 0);
      return false;
    } catch (error) {
      return record(error).code === "ESRCH";
    }
  });
}

function readMaintenanceState(root: string) {
  assertRealDirectory(root);
  assertRealDirectory(resolve(root, "runner"));
  assertRealDirectory(resolve(root, "control-plane"));
  const bytes = MAINTENANCE_STATE_FILES.map((file) => {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw maintenanceDenied();
    return readFileSync(path);
  });
  const [control, runner, provider] = bytes.map((value) =>
    record(JSON.parse(value.toString("utf8"))),
  );
  return {
    control: control!,
    runner: runner!,
    provider: provider!,
    providerFingerprint: createHash("sha256").update(bytes[2]!).digest("hex"),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          bytes.map((value) =>
            createHash("sha256").update(value).digest("hex"),
          ),
        ),
      )
      .digest("hex"),
  };
}

/** An exact completed receipt is delivery evidence, never launch authority.
 * The caller must additionally own the preceding retired maintenance epoch. */
function completedMaintenanceTerminalReceipt(
  state: ReturnType<typeof readMaintenanceState>,
) {
  const pending = record(state.runner.pendingTerminalDelivery);
  const commands = state.control.commands as Array<Record<string, unknown>>;
  if (
    state.runner.lifecycle !== "suspended" ||
    pending.commandType !== "runner.suspend" ||
    pending.lifecycle !== "suspended" ||
    typeof pending.commandId !== "string" ||
    !pending.commandId ||
    !Number.isSafeInteger(pending.controllerSeq) ||
    Number(pending.controllerSeq) <= 0 ||
    pending.controllerSeq !== state.runner.lastControllerCommandSeq ||
    state.runner.pendingProviderCleanup != null ||
    state.provider.lifecycle !== "prepared" ||
    state.provider.activeProviderTurnId != null ||
    !Array.isArray(commands)
  )
    return null;
  const matching = commands.filter(
    (command) => command.commandId === pending.commandId,
  );
  const command = matching[0];
  const result = record(
    record(state.runner.processedCommands)[pending.commandId],
  );
  if (
    matching.length !== 1 ||
    !command ||
    command.type !== pending.commandType ||
    command.controllerSeq !== pending.controllerSeq ||
    result.commandId !== pending.commandId ||
    result.commandType !== pending.commandType ||
    result.controllerSeq !== pending.controllerSeq ||
    result.status !== "completed" ||
    record(result.result).status !== "completed"
  )
    return null;
  // Match Rust's serialized Command, including nullable defaulted fields.
  const wire = {
    schema: command.schema,
    commandId: command.commandId,
    controllerSeq: command.controllerSeq,
    type: command.type,
    issuedAt: command.issuedAt,
    deadlineAt: command.deadlineAt ?? null,
    precondition: command.precondition ?? null,
    payload: command.payload,
  };
  if (
    record(state.runner.processedCommandFingerprints)[pending.commandId] !==
    commandDigest(wire).slice("sha256:".length)
  )
    return null;
  if (command.status === "pending") {
    // Welcome advertises only the first pending command. Absence from that
    // one-element list cannot prove a later terminal result was delivered.
    if (
      commands.find((entry) => entry.status === "pending") !== command ||
      command.result != null
    )
      return null;
  } else if (
    command.status !== "completed" ||
    commandDigest(command.result) !== commandDigest(result)
  ) {
    return null;
  }
  return { commandId: pending.commandId, result };
}

function completedMaintenanceTerminalReplayMatches(
  before: ReturnType<typeof readMaintenanceState>,
  after: ReturnType<typeof readMaintenanceState>,
) {
  const receipt = completedMaintenanceTerminalReceipt(before);
  if (!receipt) return false;
  const expectedCommands = (
    before.control.commands as Array<Record<string, unknown>>
  ).map((command) =>
    command.commandId === receipt.commandId
      ? { ...command, status: "completed", result: receipt.result }
      : command,
  );
  return (
    after.runner.lifecycle === "suspended" &&
    after.runner.pendingTerminalDelivery == null &&
    after.runner.pendingProviderCleanup == null &&
    after.providerFingerprint === before.providerFingerprint &&
    commandDigest(after.runner.processedCommands) ===
      commandDigest(before.runner.processedCommands) &&
    commandDigest(after.runner.processedCommandFingerprints) ===
      commandDigest(before.runner.processedCommandFingerprints) &&
    after.runner.lastControllerCommandSeq ===
      before.runner.lastControllerCommandSeq &&
    commandDigest(after.control.commands) === commandDigest(expectedCommands)
  );
}

function assertMaintenanceBinding(
  state: ReturnType<typeof readMaintenanceState>,
  identity: DurableRecoveryIdentity,
  providerSessionId: string,
  allowRestoringOpen = false,
) {
  if (
    !recoveryIdentityMatches(record(state.control.identity), identity) ||
    !recoveryIdentityMatches(state.runner, identity) ||
    state.runner.schema !== "paperclip.runner.durable.state.v1" ||
    state.provider.schema !== "paperclip.runner.codex-provider-state.v1" ||
    record(state.provider.config).provider !== "codex" ||
    state.provider.threadId !== providerSessionId ||
    !Array.isArray(state.runner.outbox) ||
    !Array.isArray(state.provider.pendingEvents) ||
    !Array.isArray(state.provider.queuedEvents) ||
    !Array.isArray(state.control.commands) ||
    !Array.isArray(state.control.committedEvents) ||
    Object.keys(record(record(state.provider.toolBridge).pending)).length !==
      0 ||
    state.provider.ambiguousTurnStartPending === true ||
    !(
      allowRestoringOpen
        ? ["turn_active", "prepared", "session_open"]
        : ["turn_active", "prepared"]
    ).includes(String(state.provider.lifecycle))
  )
    throw maintenanceDenied();
}

/** A proof cannot be manufactured by JSON or reused after the activated
 * checkpoint or any of its exact process owners changes. */
export function retainedRunnerdCleanupProofIsCurrent(
  proof: RetainedRunnerdCleanupProof,
): boolean {
  const pids = retainedRunnerdCleanupProofs.get(proof);
  if (!pids || !pids.every(maintenanceProcessAbsent)) return false;
  try {
    const state = readMaintenanceState(proof.activationDirectory);
    assertMaintenanceBinding(state, proof.identity, proof.providerSessionId);
    return (
      state.fingerprint === proof.settledFingerprint &&
      state.runner.lifecycle === "suspended" &&
      state.runner.pendingTerminalDelivery == null &&
      state.runner.pendingProviderCleanup == null
    );
  } catch {
    return false;
  }
}

/** Settle an inventoried COPY of one retained local Codex authority. This is
 * deliberately not a NativeSession: it has no turn-start, tool execution,
 * result selection, or authority-rotation API. The embedding server owns the
 * durable recovery lease, original-source proof, and atomic activation. */
export interface RetainedRunnerdMaintenanceInput {
  requestId: string;
  binding: NativeRunIdentity;
  identity: DurableRecoveryIdentity;
  backend: { kind: string; name: string };
  stateDirectory: string;
  activationDirectory: string;
  sourceFingerprint: string;
  providerSessionId: string;
  originalRunnerPid: number;
  originalProviderPid: number;
  runnerBinary?: string;
  environment?: NodeJS.ProcessEnv;
  sourceCodexHome?: string | null;
  authorize: () => Promise<void>;
  appendEvent: (event: PrpEvent) => Promise<void>;
  recordEpoch: (
    receipt: RetainedRunnerdMaintenanceEpochReceipt,
  ) => Promise<void>;
  signal?: AbortSignal;
}

export async function settleRetainedRunnerdSession(
  input: RetainedRunnerdMaintenanceInput,
): Promise<RetainedRunnerdCleanupProof> {
  const root = resolve(input.stateDirectory);
  if (!retainedRunnerdMaintenanceIsIdle(root)) throw maintenanceDenied();
  activeMaintenanceRoots.add(root);
  try {
    return await settleRetainedRunnerdSessionOwned(input);
  } finally {
    activeMaintenanceRoots.delete(root);
  }
}

async function settleRetainedRunnerdSessionOwned(
  input: RetainedRunnerdMaintenanceInput,
): Promise<RetainedRunnerdCleanupProof> {
  const root = resolve(input.stateDirectory);
  if (
    !input.requestId ||
    input.requestId.length > 160 ||
    /[\x00-\x1f]/.test(input.requestId) ||
    retainedMaintenanceOperations.has(root) ||
    root === resolve(input.activationDirectory) ||
    input.binding.runId !== input.identity.runId ||
    input.binding.sessionId !== input.identity.normalizedSessionId ||
    !input.providerSessionId
  )
    throw maintenanceDenied();
  const initial = readMaintenanceState(root);
  assertMaintenanceBinding(initial, input.identity, input.providerSessionId);
  if (initial.fingerprint !== input.sourceFingerprint)
    throw maintenanceDenied();
  const originalCommands = initial.control.commands as Array<
    Record<string, unknown>
  >;
  if (
    originalCommands.some(
      (command) =>
        command.status === "pending" &&
        !["turn.stop", "runner.drain", "runner.suspend"].includes(
          String(command.type),
        ),
    )
  )
    throw maintenanceDenied();
  const retainedEvents = [
    ...(initial.runner.outbox as unknown[]).map((event) =>
      record(record(record(event).envelope).payload),
    ),
    ...(initial.provider.pendingEvents as unknown[]).map(record),
    ...(initial.provider.queuedEvents as unknown[]).map(record),
  ];
  // This bounded recovery does not resolve or redeliver any tool input, even
  // a historical input whose result might already exist in the old journal.
  if (
    retainedEvents.some((event) =>
      [
        "semantic_tool.input",
        "mcp_app.tool_input",
        "runtime.input.requested",
        "runtime_request.created",
      ].includes(String(event.eventType)),
    )
  )
    throw maintenanceDenied();
  for (const event of retainedEvents) {
    if (
      !["session.started", "session.resumed", "harness.ready"].includes(
        String(event.eventType),
      )
    )
      continue;
    const identity = resolveRunnerdSessionIdentity(event.payload);
    // Replayed historical identities cannot grant authority to kill a PID
    // that may have since been reused by an unrelated process.
    if (
      identity.threadId !== input.providerSessionId ||
      identity.processId !== input.originalProviderPid
    )
      throw maintenanceDenied();
  }
  const pids = new Set([input.originalRunnerPid, input.originalProviderPid]);
  const providerProofs = new Map<
    number,
    { sourceEventId: string; digest: string; authenticated: boolean }
  >();
  if (pids.size !== 2 || ![...pids].every(maintenanceProcessAbsent))
    throw maintenanceDenied();
  const runnerBinary = input.runnerBinary ?? defaultCapabilityRunnerdBinary();
  const artifact = approvedRunnerArtifact(runnerBinary);
  const codexHome = resolve(root, "codex-home");
  const deadline = Date.now() + 30_000;
  let failure: unknown;
  const eventCommits = new Set<Promise<void>>();
  const bounded = async <T>(
    operation: Promise<T>,
    expiresAt = deadline,
    cleanup = false,
  ): Promise<T> => {
    const retained =
      retainedMaintenanceOperations.get(root) ?? new Set<Promise<unknown>>();
    retainedMaintenanceOperations.set(root, retained);
    retained.add(operation);
    const released = () => {
      retained.delete(operation);
      if (
        !retained.size &&
        retainedMaintenanceOperations.get(root) === retained
      )
        retainedMaintenanceOperations.delete(root);
    };
    void operation.then(released, released);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          const fail = () => {
            failure ??= maintenanceDenied();
            reject(failure);
          };
          timer = setTimeout(fail, Math.max(0, expiresAt - Date.now()));
          abort = fail;
          if (!cleanup) {
            input.signal?.addEventListener("abort", abort, { once: true });
            if (input.signal?.aborted) fail();
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) input.signal?.removeEventListener("abort", abort);
    }
  };
  const authorize = async () => {
    input.signal?.throwIfAborted();
    if (failure) throw failure;
    if (Date.now() >= deadline) throw maintenanceDenied();
    await bounded(input.authorize());
    // A callback can synchronously revoke/abort and return a resolved promise;
    // that result must not win Promise.race over the already-latched denial.
    input.signal?.throwIfAborted();
    if (failure) throw failure;
    if (Date.now() >= deadline) throw maintenanceDenied();
  };
  await authorize();
  await bounded(
    releaseMaterializedNativeRuntimeSkills(resolve(codexHome, "skills")),
  );
  await bounded(
    prepareIsolatedCodexHome({
      context: null,
      codexHome,
      sourceCodexHome:
        input.sourceCodexHome ?? resolveSourceCodexHome(input.environment),
      apiKey:
        input.environment?.CODEX_API_KEY ?? input.environment?.OPENAI_API_KEY,
    }),
  );
  // A previously journaled suspend must be honored before a later drain.
  // A second exact-authority connection can then drain the retained provider
  // prefix; no old command is removed, reordered, or treated as completed.
  let completedTerminalEpochFingerprint: string | null = null;
  for (let epoch = 0; epoch < 4; epoch++) {
    await authorize();
    if (![...pids].every(maintenanceProcessAbsent)) throw maintenanceDenied();
    const before = readMaintenanceState(root);
    assertMaintenanceBinding(before, input.identity, input.providerSessionId);
    const terminalOnly = before.runner.pendingTerminalDelivery != null;
    const pendingTerminal = record(before.runner.pendingTerminalDelivery);
    const completedTerminalOnly =
      terminalOnly &&
      completedTerminalEpochFingerprint === before.fingerprint &&
      completedMaintenanceTerminalReceipt(before) !== null;
    completedTerminalEpochFingerprint = null;
    if (
      terminalOnly &&
      !completedTerminalOnly &&
      !(before.control.commands as Array<Record<string, unknown>>).some(
        (command) =>
          command.commandId === pendingTerminal.commandId &&
          command.controllerSeq === pendingTerminal.controllerSeq &&
          command.type === "runner.suspend" &&
          pendingTerminal.commandType === "runner.suspend" &&
          pendingTerminal.lifecycle === "suspended" &&
          command.status === "failed",
      )
    )
      throw maintenanceDenied();
    const epochRestoresProvider =
      !terminalOnly && before.provider.lifecycle === "turn_active";
    const epochProviderPids = new Set<number>();
    const epochCompletedCommands = new Set(
      (before.control.commands as Array<Record<string, unknown>>)
        .filter((command) => command.status !== "pending")
        .map((command) => command.commandId),
    );
    if (
      !terminalOnly &&
      !epochRestoresProvider &&
      (before.provider.activeProviderTurnId != null ||
        (before.control.commands as Array<Record<string, unknown>>).some(
          (command) =>
            command.status === "pending" &&
            !["runner.drain", "runner.suspend"].includes(String(command.type)),
        ))
    ) {
      throw maintenanceDenied();
    }
    let releaseSpawnAdmission!: () => void;
    let rejectSpawnAdmission!: (error: unknown) => void;
    const spawnAdmission = new Promise<void>(
      (resolveAdmission, rejectAdmission) => {
        releaseSpawnAdmission = resolveAdmission;
        rejectSpawnAdmission = rejectAdmission;
      },
    );
    // A launch failure can reject this before any runner reaches authentication.
    void spawnAdmission.catch(() => undefined);
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(root, "control-plane"),
      identity: input.identity,
      expectedRunnerVersion: artifact.version,
      expectedRunnerDigest: artifact.digest,
      beforeAuthenticatedConnection: async () => {
        await spawnAdmission;
        await authorize();
      },
      onProtocolIntegrityError: (error) => {
        failure = error;
      },
      onSemanticToolInput: async () => {
        // Never delegate a tool from a cleanup connection.
        throw maintenanceDenied();
      },
      onCommittedEvent: (event) => {
        const commit = (async () => {
          try {
            if (
              [
                "semantic_tool.input",
                "mcp_app.tool_input",
                "runtime.input.requested",
                "runtime_request.created",
              ].includes(event.eventType)
            ) {
              throw maintenanceDenied();
            }
            if (
              ["session.started", "session.resumed", "harness.ready"].includes(
                event.eventType,
              )
            ) {
              const identity = resolveRunnerdSessionIdentity(event.payload);
              if (
                identity.threadId !== input.providerSessionId ||
                identity.processId === null
              )
                throw maintenanceDenied();
              pids.add(identity.processId);
              if (identity.processId !== input.originalProviderPid) {
                const digest = commandDigest(event.payload);
                const prior = providerProofs.get(identity.processId);
                if (
                  prior &&
                  (prior.sourceEventId !== event.sourceEventId ||
                    prior.digest !== digest)
                )
                  throw maintenanceDenied();
                if (!prior) epochProviderPids.add(identity.processId);
                providerProofs.set(identity.processId, {
                  sourceEventId: event.sourceEventId,
                  digest,
                  authenticated: true,
                });
              }
            }
            await authorize();
            await bounded(input.appendEvent(event));
          } catch (error) {
            failure = error;
            throw error;
          }
        })();
        eventCommits.add(commit);
        void commit.then(
          () => eventCommits.delete(commit),
          () => eventCommits.delete(commit),
        );
        return commit;
      },
    });
    let handle: RunnerProcessHandle | null = null;
    let exited = false;
    let epochCompleted = false;
    let retiredFingerprint: string | null = null;
    const epochIdentity = {
      schema: "paperclip.native_cleanup_runner_epoch.v1" as const,
      requestId: input.requestId,
      epoch,
      launchId: randomUUID(),
      stateDirectory: root,
      initialFingerprint: before.fingerprint,
      runnerArtifact: { path: resolve(runnerBinary), ...artifact },
    };
    let spawnedReceipt: Extract<
      RetainedRunnerdMaintenanceEpochReceipt,
      { phase: "spawned" }
    > | null = null;
    try {
      const pending = core.store.state.commands.filter(
        (command) => command.status === "pending",
      );
      let terminalQueued = pending.some(
        (command) => command.type === "runner.suspend",
      );
      if (
        !terminalOnly &&
        !terminalQueued &&
        before.provider.activeProviderTurnId !== null &&
        before.provider.activeProviderTurnId !== undefined
      ) {
        core.queueCommand("turn.stop", {
          reason: "exact retained authority cleanup",
        });
      }
      await core.start();
      await authorize();
      epochIdentity.initialFingerprint = readMaintenanceState(root).fingerprint;
      await bounded(
        input.recordEpoch({ ...epochIdentity, phase: "launch_intent" }),
      );
      await authorize();
      handle = spawnRunner({
        connectUrl: core.connectUrl,
        stateDirectory: resolve(root, "runner"),
        identity: input.identity,
        ticket: core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
        maxOutboxBytes: RUNNERD_MAX_OUTBOX_BYTES,
        p0ReserveBytes: RUNNERD_P0_RESERVE_BYTES,
        maxRuntimeMs: 30_000,
        reconnectGraceMs: 2_000,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        runnerBinaryPath: runnerBinary,
        runnerVersion: artifact.version,
        runnerDigest: artifact.digest,
        environment: createCapabilityRunnerdProviderEnvironment({
          provider: "codex",
          options: { environment: input.environment },
          identity: input.identity,
          codexHome,
          runtimeContextPath: resolve(root, "runtime-context.json"),
          hasRuntimeContext: false,
        }),
      });
      if (!handle.child.pid) throw maintenanceDenied();
      pids.add(handle.child.pid);
      void handle.completion.then(
        () => {
          exited = true;
        },
        (error) => {
          exited = true;
          failure = error;
        },
      );
      const processStartedAt = readLocalProcessStartedAt(handle.child.pid);
      if (
        !processStartedAt ||
        !handle.startedAt ||
        handle.processGroupId !== handle.child.pid
      )
        throw maintenanceDenied();
      spawnedReceipt = {
        ...epochIdentity,
        phase: "spawned",
        pid: handle.child.pid,
        processGroupId: handle.processGroupId,
        processStartedAt,
        spawnedAt: handle.startedAt,
      };
      await bounded(input.recordEpoch(spawnedReceipt));
      await authorize();
      releaseSpawnAdmission();
      let drainQueued = false;
      while (!exited) {
        await authorize();
        const state = readMaintenanceState(root);
        assertMaintenanceBinding(
          state,
          input.identity,
          input.providerSessionId,
          epochRestoresProvider,
        );
        const provider = providerDrainStateFromSnapshot(state.provider);
        if (!terminalOnly && !terminalQueued && provider.providerSettled) {
          if (!drainQueued) {
            core.queueCommand("runner.drain", {}, undefined, true);
            drainQueued = true;
          } else if (
            provider.pendingEventCount === 0 &&
            (state.runner.outbox as unknown[]).length === 0 &&
            !core.store.state.commands.some(
              (command) => command.status === "pending",
            )
          ) {
            core.queueCommand("runner.suspend", {}, undefined, true);
            terminalQueued = true;
          }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      await handle.completion;
      await authorize();
      epochCompleted = true;
    } finally {
      rejectSpawnAdmission(failure ?? maintenanceDenied());
      if (handle && !exited) {
        await waitForProcess(handle, 250).catch(() => undefined);
        // waitForProcess rejects when it dispatches SIGKILL, before the exact
        // child's exit notification necessarily arrives. Join that existing
        // completion separately; a kill attempt never stands in for proof.
        await bounded(handle.completion, Date.now() + 1_000, true).catch(
          () => undefined,
        );
      }
      await core.stop();
      let processingDrained = false;
      try {
        // Closing sockets does not join already queued JSON/auth callbacks.
        // No retirement fingerprint or new core may race an old store write.
        const normalRetirement = epochCompleted && !failure;
        await bounded(
          core.drainPendingConnectionProcessing(),
          normalRetirement ? deadline : Math.min(deadline, Date.now() + 1_000),
          !normalRetirement,
        );
        processingDrained = true;
      } catch (error) {
        failure ??= error;
      }
      // Do not mistake a bounded wait/kill attempt for retirement. Only the
      // exact child's settled completion plus absence of its entire group can
      // produce this durable receipt. A missing receipt remains unknown.
      if (handle && spawnedReceipt && exited && processingDrained) {
        try {
          const result = await handle.completion;
          if (!maintenanceProcessAbsent(spawnedReceipt.pid))
            throw maintenanceDenied();
          const finalFingerprint = readMaintenanceState(root).fingerprint;
          await bounded(
            input.recordEpoch({
              ...spawnedReceipt,
              phase: "retired",
              exitCode: result.code,
              exitSignal: result.signal,
              processGroupAbsent: true,
              retiredAt: new Date().toISOString(),
              finalFingerprint,
            }),
            Date.now() + 1_000,
            true,
          );
          retiredFingerprint = finalFingerprint;
        } catch (error) {
          failure ??= error;
        }
      } else if (handle) {
        failure ??= maintenanceDenied();
      }
      // Timed-out database operations remain observed in the retained map;
      // they cannot authorize another attempt or produce a cleanup proof.
      await bounded(
        Promise.allSettled([...eventCommits]),
        Date.now() + 1_000,
      ).catch(() => undefined);
      if (!epochCompleted || failure) {
        // Only a newly authenticated exact provider identity is kill
        // authority. An interrupted startup with no identity stays unknown
        // and cannot produce a settlement proof or clear quarantine.
        const owned = [...providerProofs]
          .filter(([, proof]) => proof.authenticated)
          .map(([pid]) => pid);
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          for (const pid of owned) {
            if (!maintenanceProcessAbsent(pid)) {
              try {
                process.kill(-pid, signal);
              } catch {
                /* keep the failed owner retained */
              }
            }
          }
          const cleanupDeadline = Date.now() + 500;
          while (
            !owned.every(maintenanceProcessAbsent) &&
            Date.now() < cleanupDeadline
          ) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          }
        }
      }
    }
    if (failure) throw failure;
    // Retirement itself may await durable authorization callbacks. It proves
    // process exit, not permission to publish a reusable cleanup proof.
    await authorize();
    const settled = readMaintenanceState(root);
    assertMaintenanceBinding(settled, input.identity, input.providerSessionId);
    if (settled.runner.lifecycle !== "suspended") throw maintenanceDenied();
    if (terminalOnly) {
      if (completedTerminalOnly) {
        // The previous epoch durably completed this command but missed its
        // ACK. This epoch may only deliver that exact result and old outbox;
        // it cannot restore a provider or count as a new physical stop.
        if (
          !completedMaintenanceTerminalReplayMatches(before, settled) ||
          settled.fingerprint !== retiredFingerprint ||
          epochProviderPids.size !== 0 ||
          ![...pids].every(maintenanceProcessAbsent)
        )
          throw maintenanceDenied();
        continue;
      }
      // This epoch only confirms delivery of a failed old terminal receipt.
      // It cannot count as provider cleanup or create/execute a command. A
      // separate epoch must perform a NEW stop under the persistent marker.
      if (
        settled.providerFingerprint !== before.providerFingerprint ||
        settled.runner.pendingTerminalDelivery != null ||
        commandDigest(settled.runner.pendingProviderCleanup) !==
          commandDigest(pendingTerminal) ||
        commandDigest(settled.control.commands) !==
          commandDigest(before.control.commands) ||
        epochProviderPids.size !== 0 ||
        ![...pids].every(maintenanceProcessAbsent)
      )
        throw maintenanceDenied();
      continue;
    }
    // The old suspend can precede the restored process's identity event on
    // the wire. Keep that persisted identity provisional until the next
    // no-launch epoch authenticates the exact source event and payload.
    for (const raw of [
      ...(settled.provider.pendingEvents as unknown[]),
      ...(settled.provider.queuedEvents as unknown[]),
    ]) {
      const event = record(raw);
      if (event.eventType !== "session.resumed") continue;
      const identity = resolveRunnerdSessionIdentity(event.payload);
      if (
        identity.threadId !== input.providerSessionId ||
        identity.processId === null ||
        typeof event.executorEventId !== "string"
      )
        throw maintenanceDenied();
      if (identity.processId === input.originalProviderPid) continue;
      const sourceEventId = `event_executor_${createHash("sha256")
        .update("paperclip.executor-event.v1\0")
        .update(input.identity.runnerInstanceId)
        .update("\0")
        .update(event.executorEventId)
        .digest("hex")}`;
      const digest = commandDigest(event.payload);
      const prior = providerProofs.get(identity.processId);
      if (
        prior &&
        (prior.sourceEventId !== sourceEventId || prior.digest !== digest)
      )
        throw maintenanceDenied();
      if (!prior) {
        epochProviderPids.add(identity.processId);
        providerProofs.set(identity.processId, {
          sourceEventId,
          digest,
          authenticated: false,
        });
      }
      pids.add(identity.processId);
    }
    if (
      !Number.isSafeInteger(before.provider.providerProcessGeneration) ||
      settled.provider.providerProcessGeneration !==
        Number(before.provider.providerProcessGeneration) +
          (epochRestoresProvider ? 1 : 0)
    )
      throw maintenanceDenied();
    const provider = providerDrainStateFromSnapshot(settled.provider);
    const stops = (
      settled.control.commands as Array<Record<string, unknown>>
    ).filter(
      (command) =>
        command.type === "turn.stop" &&
        !epochCompletedCommands.has(command.commandId),
    );
    // A successful prior epoch must never cover an unidentified process from
    // a later startup. Prepared drain-only epochs cannot launch a provider;
    // every restoring epoch needs its own authenticated PID and exit proof.
    const stopProven = !epochRestoresProvider
      ? epochProviderPids.size === 0
      : epochProviderPids.size === 1 &&
        stops.length > 0 &&
        stops.every(
          (command) =>
            command.status === "completed" &&
            record(record(command.result).result).providerExitConfirmed ===
              true,
        );
    if (!stopProven || ![...pids].every(maintenanceProcessAbsent))
      throw maintenanceDenied();
    if (completedMaintenanceTerminalReceipt(settled)) {
      // Only a joined child whose retirement receipt committed in THIS
      // invocation can enable the next delivery-only epoch. A copied initial
      // terminal marker or an interrupted/unknown child remains quarantined.
      if (!retiredFingerprint || settled.fingerprint !== retiredFingerprint)
        throw maintenanceDenied();
      completedTerminalEpochFingerprint = settled.fingerprint;
    }
    if (
      settled.provider.lifecycle === "prepared" &&
      settled.runner.pendingTerminalDelivery == null &&
      settled.runner.pendingProviderCleanup == null &&
      stopProven &&
      [...providerProofs.values()].every((proof) => proof.authenticated) &&
      provider.providerSettled &&
      provider.pendingEventCount === 0 &&
      (settled.runner.outbox as unknown[]).length === 0 &&
      (settled.control.commands as Array<Record<string, unknown>>).every(
        (command) => command.status !== "pending",
      ) &&
      [...pids].every(maintenanceProcessAbsent)
    ) {
      const proof = Object.freeze({
        binding: Object.freeze({ ...input.binding }),
        identity: Object.freeze({ ...input.identity }),
        backend: Object.freeze({ ...input.backend }),
        providerSessionId: input.providerSessionId,
        activationDirectory: resolve(input.activationDirectory),
        sourceFingerprint: input.sourceFingerprint,
        settledFingerprint: settled.fingerprint,
      });
      retainedRunnerdCleanupProofs.set(proof, Object.freeze([...pids]));
      return proof;
    }
  }
  throw maintenanceDenied();
}

type BuildOwnedCliArtifact =
  "acpx-runtime-sidecar.cjs" | "opencode-app-server-proxy.cjs";

function buildOwnedCliArtifactCandidates(
  artifact: BuildOwnedCliArtifact,
): readonly string[] {
  return [
    fileURLToPath(new URL(`../cli/${artifact}`, import.meta.url)),
    resolve(packageRoot, "dist", "cli", artifact),
  ];
}

function resolveBuildOwnedCliArtifact(
  artifact: BuildOwnedCliArtifact,
  candidates: readonly string[] = buildOwnedCliArtifactCandidates(artifact),
): string {
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;
  throw new Error(
    `runner_local_provider_artifact_missing: ${artifact} is absent; build @paperclipai/paperclip-runner TypeScript artifacts with build:typescript before starting a local JS-backed provider`,
  );
}

function acpxProviderPackageAuthority(
  sidecarScript: string,
  ownerPackageRoot = packageRoot,
): {
  root: string;
  manifest: string;
} {
  const cliDirectory = dirname(sidecarScript);
  if (
    basename(sidecarScript) !== "acpx-runtime-sidecar.cjs" ||
    basename(cliDirectory) !== "cli" ||
    basename(dirname(cliDirectory)) !== "dist"
  ) {
    throw new Error(
      "runner_provider_package_root_incompatible: ACPX sidecar must use the provider package dist/cli layout",
    );
  }
  const sidecarPackageRoot = resolve(cliDirectory, "../..");
  // A local source build lives at <workspace>/packages/paperclip-runner and
  // resolves dependencies from <workspace>/node_modules. `pnpm deploy` makes
  // the package itself the deployment root and owns <deploy>/node_modules/.pnpm.
  // The older npm-installed portable shape nests the scoped package at
  // <deploy>/node_modules/@paperclipai/paperclip-runner. The verifier always
  // receives the directory that owns node_modules, regardless of which
  // portable shape launched the already-authenticated sidecar.
  const sourceDependencyRoot = resolve(ownerPackageRoot, "../..");
  const localDependencyRoot = existsSync(
    resolve(ownerPackageRoot, "node_modules", ".pnpm"),
  )
    ? ownerPackageRoot
    : basename(sourceDependencyRoot) === "node_modules"
      ? resolve(sourceDependencyRoot, "..")
      : sourceDependencyRoot;
  return sidecarPackageRoot === ownerPackageRoot
    ? {
        root: localDependencyRoot,
        manifest: resolve(ownerPackageRoot, "package.json"),
      }
    : {
        root: sidecarPackageRoot,
        manifest: resolve(sidecarPackageRoot, "package.json"),
      };
}

function acpxRunnerLaunchProfile(
  options: CapabilityRunnerdCodexTransportOptions,
  command: string,
  sidecarScript: string,
): {
  authorityDigest: string;
  command: string;
  commandSha256: string;
  sidecarScript: string;
  sidecarScriptSha256: string;
} {
  const localDigest = (path: string) =>
    `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  if (!options.runnerFilesystemRoot) {
    const buildCommand = process.execPath;
    const buildSidecarCandidates = buildOwnedCliArtifactCandidates(
      "acpx-runtime-sidecar.cjs",
    );
    if (
      options.providerNodeCommand !== undefined ||
      options.providerNodeCommandSha256 !== undefined ||
      options.acpxSidecarPath !== undefined ||
      options.acpxSidecarSha256 !== undefined ||
      options.providerPackAuthorityDigest !== undefined ||
      command !== buildCommand ||
      !buildSidecarCandidates.includes(sidecarScript)
    ) {
      throw new Error(
        "runner_local_provider_artifact_incompatible: ACPX local launch must use build-owned artifacts",
      );
    }
    const buildSidecar = resolveBuildOwnedCliArtifact(
      "acpx-runtime-sidecar.cjs",
      buildSidecarCandidates,
    );
    if (sidecarScript !== buildSidecar) {
      throw new Error(
        "runner_local_provider_artifact_incompatible: ACPX local launch must use build-owned artifacts",
      );
    }
    const commandSha256 = localDigest(buildCommand);
    const sidecarScriptSha256 = localDigest(buildSidecar);
    return {
      authorityDigest: commandDigest({
        schema: "paperclip.runner.local-acpx-authority.v1",
        commandSha256,
        sidecarScriptSha256,
      }),
      command: buildCommand,
      commandSha256,
      sidecarScript: buildSidecar,
      sidecarScriptSha256,
    };
  }
  const commandSha256 = options.providerNodeCommandSha256;
  const sidecarScriptSha256 = options.acpxSidecarSha256;
  const authorityDigest = options.providerPackAuthorityDigest;
  if (!commandSha256 || !sidecarScriptSha256 || !authorityDigest) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: ACPX launch profile omitted its provider-pack authority or verified artifact digests",
    );
  }
  return {
    authorityDigest,
    command,
    commandSha256,
    sidecarScript,
    sidecarScriptSha256,
  };
}

function opencodeRunnerLaunchProfile(
  options: CapabilityRunnerdCodexTransportOptions,
  command: string,
  proxyScript: string,
  executable: string,
): {
  command: string;
  commandSha256: string;
  proxyScript: string;
  proxyScriptSha256: string;
  executable: string;
  executableSha256: string;
} {
  const localDigest = (path: string) =>
    `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  const usesLocalBuildOwnedDefaults =
    !options.runnerFilesystemRoot &&
    options.providerNodeCommand === undefined &&
    options.opencodeProxyPath === undefined &&
    options.opencodeCommand === undefined;
  const commandSha256 =
    options.providerNodeCommandSha256 ??
    (usesLocalBuildOwnedDefaults ? localDigest(command) : null);
  const proxyScriptSha256 =
    options.opencodeProxySha256 ??
    (usesLocalBuildOwnedDefaults ? localDigest(proxyScript) : null);
  const executableSha256 =
    options.opencodeCommandSha256 ??
    (usesLocalBuildOwnedDefaults ? localDigest(executable) : null);
  if (!commandSha256 || !proxyScriptSha256 || !executableSha256) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: OpenCode launch profile omitted verified artifact digests",
    );
  }
  return {
    command,
    commandSha256,
    proxyScript,
    proxyScriptSha256,
    executable,
    executableSha256,
  };
}

function authorizedToolSet(
  tools: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  const operations = tools
    .map((tool) => ({
      operationId: String(tool.name ?? ""),
      version: 1,
      description: String(tool.description ?? ""),
      inputSchema: record(tool.inputSchema),
      responseSchema: {},
    }))
    .sort((left, right) =>
      left.operationId < right.operationId
        ? -1
        : left.operationId > right.operationId
          ? 1
          : 0,
    );
  return {
    schema: "paperclip.runner.authorized-tools.v1",
    schemaVersion: 1,
    catalogDigest: commandDigest(operations),
    operations,
  };
}

const ACPX_RESERVED_TERMINAL_TOOLS = new Set([
  "paperclip_finish",
  "paperclip_block",
]);

export function authorizedToolSetForProvider(
  provider: CapabilityRunnerdCodexTransportOptions["provider"],
  tools: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  return authorizedToolSet(
    provider === "acpx"
      ? tools.filter(
          (tool) => !ACPX_RESERVED_TERMINAL_TOOLS.has(String(tool.name ?? "")),
        )
      : tools,
  );
}

/**
 * Raw provider tracing is consumed by runnerd itself. The provider child still
 * receives the narrower allowlist enforced by Rust's `SupervisedProcess`, so
 * these controller-selected sidecar paths never enter the harness process.
 */
function withRunnerdProviderTrace(
  environment: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of [
    "PAPERCLIP_PROVIDER_TRACE_PATH",
    "PAPERCLIP_PROVIDER_TRACE_MAX_BYTES",
  ] as const) {
    const value = source?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
export function createCapabilityRunnerdProviderEnvironment(input: {
  provider: NonNullable<CapabilityRunnerdCodexTransportOptions["provider"]>;
  options: CapabilityRunnerdCodexTransportOptions;
  identity: DurableRecoveryIdentity;
  codexHome: string;
  runtimeContextPath: string;
  hasRuntimeContext: boolean;
  acpxSidecarPath?: string;
}): NodeJS.ProcessEnv {
  const commonIdentity = {
    PAPERCLIP_RUNNER_INSTANCE_ID: input.identity.runnerInstanceId,
    PAPERCLIP_RUN_ID: input.identity.runId,
    PAPERCLIP_NORMALIZED_SESSION_ID: input.identity.normalizedSessionId,
    ...(input.hasRuntimeContext
      ? { PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: input.runtimeContextPath }
      : {}),
  };
  if (input.provider === "opencode") {
    return {
      ...createSanitizedOpenCodeRunnerEnvironment(input.options.environment),
      PAPERCLIP_OPENCODE_PERMISSION_MODE:
        input.options.opencodePermissionMode ?? "ask",
      PAPERCLIP_OPENCODE_RUNTIME_DIR:
        input.options.opencodeRuntimeDirectory ??
        resolve(input.options.stateDirectory ?? tmpdir(), "opencode"),
      ...commonIdentity,
    };
  }
  if (input.provider === "acpx") {
    const sidecarPath =
      input.acpxSidecarPath ??
      input.options.acpxSidecarPath ??
      resolve(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs");
    const providerPackageAuthority = acpxProviderPackageAuthority(sidecarPath);
    return {
      ...createSanitizedAcpxSpawnInput(
        input.options.environment,
        input.options.acpxAgent ?? "codex",
      ).env,
      ...commonIdentity,
      // The verified sidecar bundle cannot use import.meta.url while Node
      // executes it through /proc/self/fd. Anchor its closed provider package
      // lookups at the package that owns the already-authenticated bundle.
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: providerPackageAuthority.root,
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
        providerPackageAuthority.manifest,
      ...(input.options.providerRecoveryPolicy ===
      "allow_replacement_after_governed_wait"
        ? {
            PAPERCLIP_ACPX_PROVIDER_RECOVERY_POLICY:
              "allow_replacement_after_governed_wait",
          }
        : {}),
    };
  }
  if (input.provider === "claude_managed") {
    return {
      ...createSanitizedClaudeManagedEnvironment(input.options.environment),
      ...commonIdentity,
    };
  }
  if (input.provider === "aws_agentcore") {
    return {
      ...createSanitizedAwsAgentCoreEnvironment(
        input.options.environment,
        input.codexHome,
      ),
      ...commonIdentity,
    };
  }
  const environment = createSanitizedCodexEnvironment({
    ...input.options.environment,
    HOME: input.codexHome,
    CODEX_HOME: input.codexHome,
  });
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"] as const) {
    const apiKey = input.options.environment?.[key];
    if (apiKey?.trim()) environment[key] = apiKey;
  }
  return environment;
}

export function resolveRunnerdAcpxPermissionMode(
  configured: CapabilityRunnerdCodexTransportOptions["acpxPermissionMode"],
): NonNullable<CapabilityRunnerdCodexTransportOptions["acpxPermissionMode"]> {
  return configured ?? "approve-reads";
}

const OPEN_CODE_RUNNER_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SystemRoot",
  "PATHEXT",
  "WINDIR",
  "RUST_BACKTRACE",
  "OPENROUTER_API_KEY",
  "PAPERCLIP_NATIVE_MCP_NAME",
  "PAPERCLIP_NATIVE_MCP_URL",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
]);

function createSanitizedOpenCodeRunnerEnvironment(
  source: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const candidate = { ...process.env, ...source };
  return Object.fromEntries(
    Object.entries(candidate).filter(
      ([key, value]) =>
        typeof value === "string" &&
        (OPEN_CODE_RUNNER_ENVIRONMENT_KEYS.has(key) ||
          /^LC_[A-Z0-9_]{1,32}$/.test(key)),
    ),
  );
}

export function resolveSourceCodexHome(
  environment: NodeJS.ProcessEnv | undefined,
): string | null {
  const explicit = environment?.CODEX_HOME?.trim();
  if (explicit) return explicit;
  const home = environment?.HOME?.trim();
  return home ? resolve(home, ".codex") : null;
}

export function trustedRuntimeReadOnlyRoots(
  environment: NodeJS.ProcessEnv | undefined,
): string[] {
  const path = environment?.PATH ?? "";
  const roots = new Set<string>();
  for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
    if (entry === "/opt/homebrew" || entry.startsWith("/opt/homebrew/")) {
      roots.add("/opt/homebrew");
    } else if (entry === "/usr/local" || entry.startsWith("/usr/local/")) {
      roots.add("/usr/local");
    } else if (entry === "/opt/local" || entry.startsWith("/opt/local/")) {
      roots.add("/opt/local");
    } else if (entry === "/nix/store" || entry.startsWith("/nix/store/")) {
      roots.add("/nix/store");
    }
  }
  return [...roots];
}

export function createRunnerdCodexAppServerArgs(input: {
  environment: NodeJS.ProcessEnv | undefined;
  codexHome: string;
  codexCommand?: string;
  readOnlyRoots?: string[];
}): string[] {
  // The filesystem policy denies HOME and CODEX_HOME to keep credentials and
  // runner state outside provider reach. Always bind those names to the actual
  // isolated runner home; a stale controller environment must never cause the
  // execution workspace itself to become an explicit deny root.
  return createIsolatedCodexAppServerArgs(
    {
      ...input.environment,
      HOME: input.codexHome,
      CODEX_HOME: input.codexHome,
    },
    [...(input.readOnlyRoots ?? []), ...codexExecutableReadOnlyRoots(input.environment ?? {}, input.codexCommand)],
  );
}

function unwrapToolResponse(response: Record<string, unknown>): {
  readonly __paperclipSemanticToolOutcome: true;
  readonly result: unknown;
  readonly isError: boolean;
} {
  const items = Array.isArray(response.contentItems)
    ? response.contentItems
    : [];
  const value = record(items[0]).text;
  let result: unknown = response;
  try {
    if (typeof value === "string") result = JSON.parse(value);
  } catch {
    result = response;
  }
  return {
    __paperclipSemanticToolOutcome: true as const,
    result,
    isError: response.success === false,
  };
}

class DurablePrpCodexTransport implements CodexAppServerTransport {
  readonly #root: string;
  readonly #ownsRoot: boolean;
  readonly #queue = new NotificationQueue();
  readonly #startedAt = new Date().toISOString();
  readonly #evidence: CapabilityRunnerdProcessEvidence;
  #handler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: "No Paperclip control-plane tool handler is installed.",
      },
    ],
  });
  #core: DurablePrpControlPlane | null = null;
  #handle: RunnerProcessHandle | null = null;
  #adoptedRunnerMonitor: NodeJS.Timeout | null = null;
  #adoptedRunnerAuthenticated = false;
  #pump: NodeJS.Timeout | null = null;
  #eventSourceSeq = 0;
  #eventIdentity: DurableRecoveryIdentity | null = null;
  #pendingWarmRecoveryCompletion: {
    transitionId: string;
    identity: DurableRecoveryIdentity;
  } | null = null;
  #warmRecoveryCompletionInFlight: Promise<void> | null = null;
  #deferredTurnStartEvents: DurableRecoveryCommittedEvent[] = [];
  #recoveryTurnBindingPending = false;
  #threadId = "";
  #sessionId: string | null = null;
  #providerIdentity: Record<string, unknown> | null = null;
  #providerIdentityEventType:
    "harness.ready" | "session.started" | "session.resumed" | null = null;
  #checkpointProviderIdentityExpectation: {
    driverSessionId: string;
    providerSessionId: string;
    providerIdentity: Record<string, unknown> | null;
  } | null = null;
  #checkpointProviderIdentityConfirmed = false;
  #turnId = "";
  #turnStartResponsePending = false;
  #turnStartResponseSettled: Promise<void> = Promise.resolve();
  #turnStartResponseEpoch = 0;
  #observedTurnStartEpoch = 0;
  #expectedProviderTurnId: string | null = null;
  #turnStartAdmission: {
    settled: Promise<boolean>;
    resolve: (accepted: boolean) => void;
  } | null = null;
  #durableTurnId = "";
  #authorizedTools: Record<string, unknown> | null = null;
  #runAttachTemplate: Record<string, unknown> | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #controllerDetachedForRestart = false;
  #failure: Error | null = null;
  readonly #failureSignal: Promise<never>;
  #rejectFailureSignal!: (error: Error) => void;
  #runnerRecoveryInProgress = false;
  #startupComplete = false;
  #startupFailureCode = "native_runner_process_exited";
  #controlPlaneCheckpoint:
    ((settlement: "settled" | "unsettled") => Promise<void> | void) | null =
    null;
  #controlPlaneRelease: (() => Promise<void> | void) | null = null;
  #nextTraceDebugSequence = 1;
  #traceRehydrationSpoolOverflow = false;
  readonly #traceFrameIndex = new RunnerdTraceFrameIndex();
  #pendingTraceRehydrations: PendingTraceRehydration[] = [];
  #pendingDriverTraceInterpretations: PendingDriverTraceInterpretation[] = [];
  readonly #bridgedRuntimeInputs = new Map<string, { durableTurnId: string }>();

  constructor(readonly options: CapabilityRunnerdCodexTransportOptions) {
    if (options.adoptExistingRunner && !options.stateDirectory?.trim()) {
      throw new Error("native_adopted_runner_state_directory_required");
    }
    if (options.provider === "acpx" && options.acpxAgent === "pi") {
      throw new Error("The Pi ACPX profile is not available");
    }
    this.#failureSignal = new Promise<never>((_resolve, reject) => {
      this.#rejectFailureSignal = reject;
    });
    // Failure is also observed by request/notification paths. Register an
    // internal handler so a process exit after the owner has closed the
    // session cannot become an unhandled process-level rejection.
    void this.#failureSignal.catch(() => undefined);
    this.#ownsRoot = options.stateDirectory === undefined;
    this.#turnId = options.resumeActiveTurnId ?? "";
    this.#root =
      options.stateDirectory ??
      mkdtempSync(resolve(tmpdir(), "paperclip-runner-lab-prp-"));
    if (options.resumeDynamicTools !== undefined) {
      this.#authorizedTools = authorizedToolSetForProvider(options.provider, [
        ...options.resumeDynamicTools,
        ...codexSemanticToolSpecs(),
      ]);
    }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#evidence = {
      runnerPid: null,
      runnerProcessGroupId: null,
      providerPid: null,
      providerProcessStartedAt: null,
      codexPid: null,
      codexProcessStartedAt: null,
      sidecarPid: null,
      sidecarProcessStartedAt: null,
      agentPid: null,
      agentProcessStartedAt: null,
      providerDriver: null,
      providerVersion: null,
      acpxAgent: null,
      agentServerVersion: null,
      agentRuntimeVersion: null,
      acpProtocolVersion: null,
      providerExecutionKind: null,
      providerService: null,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: Object.keys(
        options.provider === "acpx"
          ? createSanitizedAcpxSpawnInput(
              options.environment,
              options.acpxAgent ?? "codex",
            ).env
          : options.provider === "opencode"
            ? createSanitizedOpenCodeRunnerEnvironment(options.environment)
            : options.provider === "claude_managed"
              ? createSanitizedClaudeManagedEnvironment(options.environment)
              : options.provider === "aws_agentcore"
                ? createSanitizedAwsAgentCoreEnvironment(
                    options.environment,
                    resolve(this.#root, "codex-home"),
                  )
                : createSanitizedCodexEnvironment(options.environment),
      ).sort(),
      diagnostics: ["lab transport selected authenticated durable PRP"],
    };
  }

  evidence(): CapabilityRunnerdProcessEvidence {
    return structuredClone(this.#evidence);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("PRP Codex transport is closed");
    this.#throwIfFailed();
    if (
      this.#pendingWarmRecoveryCompletion !== null &&
      !["thread/read", "initialize", "collaborationMode/list"].includes(method)
    ) {
      throw new Error("native_runner_warm_transition_completion_pending");
    }
    if (method === "initialize") return { user: {} };
    if (method === "thread/start") return this.#start(params);
    if (method === "collaborationMode/list") {
      // runnerd negotiates the real Codex preset or the provider-proxy-owned
      // planning contract during session.open. This transport-level mask
      // confirms that closed boundary; turn/start remains runner-managed and
      // never forwards this sentinel to the outer TypeScript driver.
      return this.options.provider === undefined ||
        this.options.provider === "codex" ||
        this.options.provider === "opencode" ||
        this.options.provider === "acpx"
        ? {
            data: [
              {
                name: "Plan",
                mode: "plan",
                model: "runner-managed",
                reasoning_effort: null,
              },
            ],
          }
        : { data: [] };
    }
    if (method === "turn/start") return this.#startTurn(params);
    if (method === "turn/steer") {
      const input = Array.isArray(params.input) ? params.input.map(record) : [];
      const text = input
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("\n");
      const expectedTurnId =
        typeof params.expectedTurnId === "string"
          ? params.expectedTurnId
          : this.#turnId;
      if (!text.trim()) throw new Error("turn/steer requires a message");
      if (expectedTurnId !== this.#turnId)
        throw new Error("turn/steer named a stale turn");
      const correlationId =
        typeof params.correlationId === "string"
          ? params.correlationId
          : undefined;
      await this.#command(
        "turn.steer",
        {
          text,
          turnId: this.#durableTurnId,
          providerTurnId: expectedTurnId,
          ...(correlationId ? { correlationId } : {}),
        },
        correlationId,
      );
      return {};
    }
    if (method === "turn/interrupt") {
      await this.#command("turn.interrupt", params);
      return {};
    }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      if (params.threadId !== this.#threadId) throw new Error("codex_history_identity_mismatch");
      const snapshot = await this.request("thread/read", { threadId: this.#threadId, includeTurns: false });
      const turns = record(snapshot.thread).turns as Array<Record<string, unknown>>;
      let data: Array<Record<string, unknown>>;
      if (method === "thread/turns/list") {
        data = turns.map(turn => ({ ...turn, items: [], itemsView: "notLoaded" }));
      } else {
        if (params.turnId !== this.#turnId) throw new Error("codex_history_unavailable: requested turn is outside the retained runner event window");
        const items = new Map<string, Record<string, unknown>>();
        let observedTurn = "";
        let observedStart = false;
        for (const event of this.#core?.store.state.committedEvents ?? []) {
          const payload = record(record(event.envelope.payload).payload);
          if (event.eventType === "turn.started") observedTurn = String(payload.providerTurnId ?? payload.turnId ?? record(payload.turn).id ?? "");
          if (event.eventType === "turn.started" && observedTurn === params.turnId) observedStart = true;
          if (event.eventType !== "item.completed" || observedTurn !== params.turnId) continue;
          const item = record(rehydrateRunnerdItemNotification(payload, this.#threadId, observedTurn).item);
          if (typeof item.id === "string") items.set(item.id, { turnId: observedTurn, item });
        }
        if (!observedStart) throw new Error("codex_history_incomplete: requested turn start is outside the retained runner event window");
        data = [...items.values()];
      }
      if (params.sortDirection === "desc") data.reverse();
      const offset = params.cursor == null ? 0 : Number(params.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length) throw new Error("codex_history_invalid_cursor");
      const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, params.limit)) : 100;
      return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? String(offset + limit) : null };
    }
    if (method === "thread/read") {
      if (this.#core === null) {
        this.#recoveryTurnBindingPending = true;
        await this.#resume();
      }
      // Ask the authenticated runner for its live provider snapshot rather
      // than reading its filesystem. This both supports remote process owners
      // and proves any identity restored after PRP event compaction before the
      // checkpoint-backed thread is exposed to the driver.
      const snapshot = await this.#commandResult("session.snapshot", {});
      this.#confirmCheckpointProviderIdentity(
        snapshot,
        "authenticated session.snapshot",
      );
      const activeProviderTurnId =
        typeof snapshot.activeProviderTurnId === "string" &&
        snapshot.activeProviderTurnId.length > 0
          ? snapshot.activeProviderTurnId
          : null;
      if (activeProviderTurnId !== null) this.#turnId = activeProviderTurnId;
      const recoveredTurns: Array<Record<string, unknown>> =
        activeProviderTurnId === null
          ? []
          : [{ id: activeProviderTurnId, status: "inProgress" }];
      if (activeProviderTurnId === null && this.#turnId.length > 0) {
        const recoveryDeadline = Date.now() + 5_000;
        let terminal = (this.#core?.store.state.committedEvents ?? []).find(
          () => false,
        );
        while (Date.now() < recoveryDeadline) {
          this.#throwIfFailed();
          this.#pumpEvents();
          terminal = [...(this.#core?.store.state.committedEvents ?? [])]
            .reverse()
            .find((event) => {
              if (
                event.eventType !== "turn.completed" &&
                event.eventType !== "turn.failed" &&
                event.eventType !== "turn.interrupted" &&
                event.eventType !== "turn.cancelled"
              )
                return false;
              const payload = record(record(event.envelope.payload).payload);
              const providerTurnId =
                payload.providerTurnId ??
                payload.turnId ??
                record(payload.turn).id;
              return providerTurnId === this.#turnId;
            });
          if (terminal !== undefined) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        if (terminal !== undefined) {
          recoveredTurns.push({
            id: this.#turnId,
            status:
              terminal.eventType === "turn.completed"
                ? "completed"
                : terminal.eventType === "turn.interrupted"
                  ? "interrupted"
                  : terminal.eventType === "turn.cancelled"
                    ? "cancelled"
                    : "failed",
          });
        }
      }
      this.#recoveryTurnBindingPending = false;
      this.#pumpEvents();
      return {
        thread: {
          id: this.#threadId,
          sessionId: this.#sessionId,
          ...(this.#providerIdentity === null
            ? {}
            : { providerIdentity: structuredClone(this.#providerIdentity) }),
          cwd:
            typeof snapshot.cwd === "string" && snapshot.cwd.length > 0
              ? snapshot.cwd
              : (this.options.environment?.PAPERCLIP_WORKSPACE_CWD ??
                this.options.runnerFilesystemRoot ??
                tmpdir()),
          turns: recoveredTurns,
        },
      };
    }
    if (method === "thread/goal/get") {
      const result = await this.#commandResult("session.goal.get", params);
      return {
        goal: appServerThreadGoal(result.goal, this.#threadId),
      };
    }
    if (method === "thread/goal/set") {
      const result = await this.#commandResult("session.goal.set", params);
      const snapshot = record(result.snapshot);
      return {
        goal: appServerThreadGoal(
          snapshot.goal ?? result.goal,
          this.#threadId,
        ),
      };
    }
    if (method === "thread/goal/clear") {
      await this.#commandResult("session.goal.clear", params);
      return {};
    }
    if (method === "session/budget/increase") {
      await this.#command("session.budget.increase", params);
      return {};
    }
    if (method === "session/destroy") {
      await this.#command("session.destroy", params);
      return {};
    }
    if (method === "thread/resume") {
      if (
        this.#checkpointProviderIdentityExpectation !== null &&
        !this.#checkpointProviderIdentityConfirmed
      ) {
        const snapshot = await this.#commandResult("session.snapshot", {});
        this.#confirmCheckpointProviderIdentity(
          snapshot,
          "authenticated session.snapshot",
        );
      }
      return {
        thread: {
          id: this.#threadId,
          sessionId: this.#sessionId,
          ...(this.#providerIdentity === null
            ? {}
            : { providerIdentity: structuredClone(this.#providerIdentity) }),
        },
      };
    }
    throw new Error(
      `PRP Codex transport does not expose provider method ${method}`,
    );
  }

  notify(_method: string, _params?: Record<string, unknown>): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  async #awaitWarmRunAttachmentReady(): Promise<void> {
    // Remote runner ingress already has a bounded reconnect budget. Reuse the
    // same budget here so a transient tunnel reconnect cannot trip the shorter
    // generic command timeout and replace an otherwise healthy warm runner.
    const reconnectGraceMs = this.options.runnerReconnectGraceMs ?? 5_000;
    const deadline = Date.now() + reconnectGraceMs;
    let consecutiveReadyProbes = 0;
    let lastBlockers: unknown = null;
    while (Date.now() < deadline) {
      await this.#awaitWarmRunnerConnection(deadline);
      const snapshot = await this.#commandResult(
        "session.snapshot",
        {
          quiesceForWarmAttach: true,
        },
        deadline,
      );
      lastBlockers = snapshot.warmAttachBlockers;
      if (snapshot.warmAttachReady === true) {
        consecutiveReadyProbes += 1;
        // A second barrier prevents a provider frame emitted immediately after
        // its terminal notification from racing the authority rotation. Each
        // snapshot wakes runnerd, polls the provider, and drains the preceding
        // durable event prefix before the next probe.
        if (consecutiveReadyProbes >= 2) return;
      } else {
        consecutiveReadyProbes = 0;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(
      `native_runner_warm_attachment_not_quiescent: ${JSON.stringify(lastBlockers)}`,
    );
  }

  async #awaitWarmRunnerConnection(deadline: number): Promise<void> {
    const core = this.#core;
    if (core === null) throw new Error("native_runner_authority_unavailable");
    let reportedReconnectWait = false;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const connectionCount = core.activeRunnerConnectionCount();
      if (connectionCount === 1) {
        if (reportedReconnectWait) {
          this.#diagnostic(
            "warm runner re-authenticated before authority rotation",
          );
        }
        return;
      }
      if (connectionCount > 1) {
        throw new Error(
          `native_runner_warm_attachment_ambiguous: expected one authenticated runner, found ${connectionCount}`,
        );
      }
      if (!reportedReconnectWait) {
        reportedReconnectWait = true;
        this.#diagnostic(
          "warm runner connection interrupted; waiting for re-authentication before authority rotation",
        );
      }
      if (await this.#runnerHasExited()) {
        throw new Error(
          "native_runner_warm_attachment_runner_exited: runner exited before authority rotation",
        );
      }
      await Promise.race([
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 25)),
        this.#failureSignal,
      ]);
    }
    throw new Error(
      `provider_transport_failed: warm runner did not re-authenticate within ${this.options.runnerReconnectGraceMs ?? 5_000}ms`,
    );
  }

  async attachRun(input: {
    runId: string;
    turnId: string;
    itemId: string;
  }): Promise<void> {
    if (this.#pendingWarmRecoveryCompletion !== null) {
      throw new Error("native_runner_warm_transition_completion_pending");
    }
    const core = this.#core;
    if (!core || !this.#startupComplete) {
      throw new Error("native_runner_prp_run_rotation_unavailable");
    }
    await this.#awaitWarmRunAttachmentReady();
    const prior = core.store.state.identity;
    const desired: DurableRecoveryIdentity = {
      ...prior,
      runId: input.runId,
      turnId: input.turnId,
      itemId: input.itemId,
    };
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core, desired)
      : null;
    const previousRelease = this.#controlPlaneRelease;
    let previousReleased = false;
    let activationStarted = false;
    try {
      const connection: RunnerProcessConnection =
        registration?.connection ??
        (registration?.connectUrl
          ? { mode: "connect", connectUrl: registration.connectUrl }
          : { mode: "connect", connectUrl: core.connectUrl });
      const commandId = `command_attach_${createHash("sha256")
        .update(`${prior.runId}:${desired.runId}:${desired.turnId}`)
        .digest("hex")
        .slice(0, 32)}`;
      const runAttachTemplate = this.#runAttachTemplate
        ? retargetRunAttachPayload(
            this.#runAttachTemplate,
            desired,
            this.#authorizedTools,
            this.options.resumeCompletionContract,
          )
        : rotatedRunAttachPayload(
            core.store.state,
            desired,
            this.#authorizedTools,
            this.options.resumeCompletionContract,
          );
      this.#runAttachTemplate = structuredClone(runAttachTemplate);
      const payload = {
        ...runAttachTemplate,
        paperclipNextAuthority: { identity: desired, connection },
      };
      core.queueCommand("run.attach", payload, commandId, true);
      await this.#waitCommand("run.attach", commandId);
      const attached = core.getCommand(commandId);
      if (attached?.status !== "completed") {
        throw new Error("native_runner_prp_run_rotation_failed");
      }

      activationStarted = true;
      core.rotateRunIdentity(desired, runAttachTemplate);
      await registration?.activate?.();
      if (registration?.failure) {
        void registration.failure.catch((error: unknown) => {
          this.#failTransport(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      await this.#awaitRegistrationReady(registration?.ready);
      const activationDeadline =
        Date.now() + (this.options.runnerReconnectGraceMs ?? 5_000);
      while (
        !recoveryIdentityMatches(core.store.state.identity, desired) ||
        core.store.state.warmTransition !== undefined ||
        core.activeRunnerConnectionCount() === 0
      ) {
        if (
          Date.now() >= activationDeadline ||
          (await this.#runnerHasExited())
        ) {
          throw new Error("native_runner_warm_transition_activation_pending");
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      this.#eventIdentity = structuredClone(desired);
      this.#eventSourceSeq = 0;
      this.#deferredTurnStartEvents = [];
      this.#durableTurnId = desired.turnId;
      await previousRelease?.();
      previousReleased = true;
      this.#controlPlaneRelease = registration?.release ?? null;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // The future route is ours from registration onward, including failures
      // in template construction, capability admission, and result waiting.
      // Keep the prior release owned by close until its handoff is confirmed.
      this.#controlPlaneRelease = previousReleased ? null : previousRelease;
      await Promise.resolve()
        .then(() => registration?.release())
        .catch(() => undefined);
      if (activationStarted) {
        // Once the completed handoff is exposed, an activation failure makes
        // both routes unavailable; neither remains an ordinary-work owner.
        this.#controlPlaneRelease = null;
        if (!previousReleased) {
          await Promise.resolve()
            .then(() => previousRelease?.())
            .catch(() => undefined);
        }
        this.#failTransport(failure);
      }
      throw failure;
    }
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    if (this.#pendingWarmRecoveryCompletion !== null) {
      throw new Error("native_runner_warm_transition_completion_pending");
    }
    const pending = this.#bridgedRuntimeInputs.get(input.requestId);
    if (!pending)
      throw new Error(
        `PRP runtime request ${input.requestId} is no longer pending`,
      );
    if (!("response" in input.resolution)) {
      throw new Error(
        "runnerd-native runtime requests require a canonical question response",
      );
    }
    const commandId = `command_runtime_input_${createHash("sha256")
      .update(`${input.requestId}:${pending.durableTurnId}`)
      .digest("hex")
      .slice(0, 24)}`;
    await this.#command(
      "request.resolve",
      {
        requestId: input.requestId,
        turnId: pending.durableTurnId,
        response: input.resolution.response,
      },
      commandId,
    );
  }

  recordTraceInterpretation(input: CodexTraceInterpretation): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const traceResult = appendCodexDriverInterpretationTrace(
      this.#traceFrameIndex,
      tracePath,
      input,
      this.#nextTraceDebugSequence,
    );
    if (traceResult === "written") {
      this.#nextTraceDebugSequence += 1;
    } else if (
      traceResult === "retry" &&
      this.#pendingDriverTraceInterpretations.length < 4_096
    ) {
      this.#pendingDriverTraceInterpretations.push(structuredClone(input));
    } else if (traceResult === "retry") {
      this.#traceRehydrationSpoolOverflow = true;
    }
  }

  processInfo(): CodexTransportProcessInfo {
    return {
      pid: this.#evidence.runnerPid,
      processGroupId: this.#evidence.runnerProcessGroupId,
      startedAt: this.#startedAt,
      exited: this.#evidence.runnerExited,
      exitCode: this.#evidence.runnerExitCode,
      signal: this.#evidence.runnerSignal,
    };
  }

  async #publishSpawnedProcess(handle: RunnerProcessHandle): Promise<void> {
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = handle.processGroupId ?? null;
    this.#publish();
    if (handle.child.pid !== undefined) {
      await this.options.onSpawn?.({
        pid: handle.child.pid,
        processGroupId: handle.processGroupId ?? null,
        startedAt: this.#startedAt,
      });
    }
  }

  async #readDurableRunnerState(): Promise<Record<string, unknown>> {
    if (this.options.readRunnerState) return this.options.readRunnerState();
    return record(
      JSON.parse(
        readFileSync(
          resolve(this.#root, "runner", "runner-state.json"),
          "utf8",
        ),
      ),
    );
  }

  #providerDrainState():
    | {
        pendingEventCount: number;
        activeProviderTurnId: string | null;
        providerSettled: boolean;
      }
    | "unreadable"
    | null {
    if (this.options.runnerFilesystemRoot !== undefined) return null;
    const provider = this.options.provider ?? "codex";
    const filename =
      provider === "acpx"
        ? "acpx-provider-state.json"
        : provider === "claude_managed" || provider === "aws_agentcore"
          ? "managed-provider-state.json"
          : "codex-provider-state.json";
    const stateDirectory =
      this.options.runnerStateDirectory ?? resolve(this.#root, "runner");
    const statePath = resolve(stateDirectory, filename);
    if (!existsSync(statePath)) {
      if (this.#startupComplete) return "unreadable";
      return {
        pendingEventCount: 0,
        activeProviderTurnId: null,
        providerSettled: true,
      };
    }
    try {
      const state = record(JSON.parse(readFileSync(statePath, "utf8")));
      return providerDrainStateFromSnapshot(state);
    } catch {
      return "unreadable";
    }
  }

  async #stopActiveProviderTurnBeforeSuspend(deadline: number): Promise<void> {
    const state = this.#providerDrainState();
    const core = this.#core;
    const inferredActiveProviderTurnId =
      state === null &&
      core !== null &&
      providerTurnIsActiveFromCommittedEvents(core.store.state.committedEvents)
        ? this.#turnId || this.#durableTurnId
        : null;
    const activeProviderTurnId =
      state !== null && state !== "unreadable"
        ? state.activeProviderTurnId
        : inferredActiveProviderTurnId;
    if (
      state === "unreadable" ||
      activeProviderTurnId === null ||
      core === null
    ) {
      return;
    }
    const commandId = `command_close_stop_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(
      "turn.stop",
      { reason: "transport closing after durable run terminal" },
      commandId,
      true,
    );
    while (Date.now() < deadline) {
      this.#pumpEventsSafely();
      const command = core.store.state.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (command?.status === "completed") {
        this.#diagnostic(
          `stopped active provider turn ${activeProviderTurnId} before runner suspension`,
        );
        return;
      }
      if (command !== undefined && command.status !== "pending") {
        this.#diagnostic(
          `provider turn stop ${command.status} before runner suspension`,
        );
        return;
      }
      if (await this.#runnerHasExited()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    this.#diagnostic("provider turn stop timed out before runner suspension");
  }

  async #drainSettledProviderEventsBeforeSuspend(
    timeoutMs = 1_000,
  ): Promise<boolean> {
    const core = this.#core;
    if (!core) return false;
    try {
      const drained = await awaitProviderDrainBarrier({
        readProviderState: () => this.#providerDrainState(),
        semanticResultsSettled: () => core.semanticToolResultsSettled(),
        commands: () => core.store.state.commands,
        queueDrain: (commandId) => {
          core.queueCommand("runner.drain", {}, commandId, true);
        },
        pump: () => this.#pumpEventsSafely(),
        deadline: Date.now() + timeoutMs,
      });
      if (drained) return true;
    } catch {
      // A failed drain still proceeds through bounded suspension/containment,
      // but can never authorize a reusable checkpoint or deletion of evidence.
    }
    const lastDrain = [...core.store.state.commands]
      .reverse()
      .find((command) => command.type === "runner.drain");
    this.#diagnostic(
      "provider suffix did not prove durable drain before bounded runner suspension: " +
        JSON.stringify({
          providerState: this.#providerDrainState(),
          semanticResultsSettled: core.semanticToolResultsSettled(),
          drainStatus: lastDrain?.status ?? null,
          retainedEventsDrained:
            record(record(lastDrain?.result).result).retainedEventsDrained ?? null,
        }),
    );
    return false;
  }

  close(reason?: string): Promise<void> {
    // Detachment relinquishes process ownership. A late execution finalizer
    // must not suspend or signal the runner now owned by the next controller.
    if (this.#controllerDetachedForRestart) return Promise.resolve();
    if (reason) {
      this.#diagnostic(
        `runner transport close requested: ${reason.replaceAll(/[\r\n]/g, " ").slice(0, 1_000)}`,
      );
    }
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async detachControllerForRestart(): Promise<void> {
    if (this.#closed) return;
    this.#controllerDetachedForRestart = true;
    this.#closed = true;
    this.#turnStartAdmission?.resolve(false);
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    if (this.#adoptedRunnerMonitor !== null)
      clearInterval(this.#adoptedRunnerMonitor);
    this.#adoptedRunnerMonitor = null;
    this.#core?.disconnectActiveRunner();
    const release = this.#controlPlaneRelease;
    this.#controlPlaneRelease = null;
    await Promise.resolve(release?.()).catch((error: unknown) => {
      this.#diagnostic(
        `controller route release failed during restart detach: ${String(error)}`,
      );
    });
    await this.#core?.stop().catch((error: unknown) => {
      this.#diagnostic(
        `controller authority stop failed during restart detach: ${String(error)}`,
      );
    });
    this.#handle = null;
    this.#queue.close();
    this.#diagnostic(
      "controller authority detached for restart; durable runner left alive",
    );
  }

  async #closeOnce(): Promise<void> {
    this.#closed = true;
    this.#turnStartAdmission?.resolve(false);
    const adoptedRunner = this.options.adoptExistingRunner;
    // `settled` is a durable-state assertion, not merely the absence of a
    // process handle. Registration can install a remote checkpoint callback
    // before process launch; a synchronous launch failure must therefore stay
    // `unsettled` and preserve its original bootstrap diagnostic.
    let runnerSuspended = false;
    let providerDrained = false;
    let suspensionRequired = false;
    if (
      this.#core !== null &&
      (this.#handle !== null || adoptedRunner !== undefined) &&
      (adoptedRunner === undefined || this.#adoptedRunnerAuthenticated) &&
      (this.#failure === null || this.#startupComplete)
    ) {
      // A terminal provider frame can become visible one control loop before
      // its durable provider suffix is ACKed. Drain it before suspension so a
      // fresh run authority never inherits the prior run's pending events.
      const { preparationDeadline, closeDeadline } = runnerCloseDeadlines(
        Date.now(),
        this.options.closeGraceMs ?? 10_000,
      );
      if (!(await this.#runnerHasExited())) {
        // Let an already-admitted tool result reach its original provider
        // before turn.stop can retire that tool-call identity. This shares the
        // close preparation deadline; a stuck callback never stalls cleanup.
        while (
          !this.#core.semanticToolResultsSettled() &&
          Date.now() < preparationDeadline
        ) {
          this.#pumpEventsSafely();
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }
        // The drain always needs one real command round trip to the runner
        // process, whether or not a turn was active: stopping an active
        // turn only changes how much trailing event traffic that round
        // trip may need to carry. Give both cases the same budget so a
        // slow-but-idle runner is not held to a tighter deadline than a
        // runner that just stopped a turn.
        await this.#stopActiveProviderTurnBeforeSuspend(preparationDeadline);
        providerDrained = await this.#drainSettledProviderEventsBeforeSuspend(
          Math.min(5_000, Math.max(0, preparationDeadline - Date.now())),
        );
      }
      // Local durable roots are reused too. Process exit alone cannot prove
      // their authority is safe to rotate; require the same exact suspension
      // barrier even when there is no remote checkpoint callback.
      suspensionRequired = true;
      runnerSuspended = await awaitRunnerSuspensionBarrier({
        commands: () => this.#core?.store.state.commands ?? [],
        queueSuspend: (commandId) => {
          this.#core?.queueCommand("runner.suspend", {}, commandId, true);
        },
        readRunnerState: async () => {
          const state = await this.#readDurableRunnerState();
          assertSuspendedRunnerState(state, this.#core!.store.state.identity);
          return state;
        },
        runnerHasExited: () => this.#runnerHasExited(),
        pump: () => this.#pumpEventsSafely(),
        deadline: closeDeadline,
      });
      if (!runnerSuspended) {
        this.#diagnostic(
          "runner did not prove durable suspension before checkpoint",
        );
      }
      try {
        if (this.#handle) {
          const result = await waitForProcess(
            this.#handle,
            Math.max(0, closeDeadline - Date.now()),
          );
          this.#evidence.runnerExited = true;
          this.#evidence.runnerExitCode = result.code;
          this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
          if (result.stderr.trim())
            this.#diagnostic(result.stderr.trim().slice(-4_096));
        } else if (adoptedRunner) {
          while (
            (await adoptedRunner.isAlive()) &&
            Date.now() < closeDeadline
          ) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          if (await adoptedRunner.isAlive()) {
            await adoptedRunner.signal?.("SIGKILL");
          }
          this.#evidence.runnerExited = !(await adoptedRunner.isAlive());
        }
      } catch (error) {
        this.#diagnostic(`runner shutdown failed: ${String(error)}`);
      }
    }
    this.#flushPendingTraceRehydrations();
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (tracePath) {
      const incomplete =
        this.#traceRehydrationSpoolOverflow ||
        this.#pendingTraceRehydrations.length > 0 ||
        this.#pendingDriverTraceInterpretations.length > 0;
      const debugSequence = this.#nextTraceDebugSequence++;
      try {
        appendRunnerdTraceStatus(tracePath, {
          status: incomplete ? "incomplete" : "complete",
          reason: incomplete
            ? this.#traceRehydrationSpoolOverflow
              ? "typescript_rehydration_spool_full"
              : "typescript_rehydration_correlation_incomplete"
            : null,
          debugSequence,
          acknowledgedDebugSequence: debugSequence - 1,
        });
      } catch {
        // Raw trace failure is intentionally independent of run authority.
      }
      this.#pendingTraceRehydrations = [];
      this.#pendingDriverTraceInterpretations = [];
      this.#traceFrameIndex.clear();
    }
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    if (this.#adoptedRunnerMonitor !== null)
      clearInterval(this.#adoptedRunnerMonitor);
    this.#adoptedRunnerMonitor = null;
    this.#queue.close();
    // A suspended remote runner still owns the only readable copy of its
    // provider state. Quiesce the authenticated route, then probe its
    // independently verified durable state before releasing the process owner;
    // an incomplete or identity-conflicting state remains fail-closed.
    const finalProviderState = this.#providerDrainState();
    const runnerSettled =
      runnerSuspended &&
      providerDrained &&
      this.#core?.semanticToolResultsSettled() === true &&
      (finalProviderState === null ||
        (finalProviderState !== "unreadable" &&
          finalProviderState.pendingEventCount === 0 &&
          finalProviderState.providerSettled));
    try {
      await releaseRunnerProcessOwnership({
        runnerSettled,
        // An alive PID does not authorize controlling or replacing a runner
        // that never authenticated to this controller (for example after an
        // executable upgrade). Retain its prior checkpoint without rewriting it.
        checkpoint:
          adoptedRunner && !this.#adoptedRunnerAuthenticated
            ? null
            : this.#controlPlaneCheckpoint,
        forceKill: () => {
          this.#handle?.child.kill("SIGKILL");
        },
        release: this.#controlPlaneRelease,
      });
    } finally {
      await this.#core?.stop();
      this.#controlPlaneCheckpoint = null;
      this.#controlPlaneRelease = null;
    }
    if (suspensionRequired && !runnerSettled) {
      throw new NativeSessionCloseUnrecoverableError();
    }
    if (this.#ownsRoot && !adoptedRunner) {
      rmSync(this.#root, { recursive: true, force: true });
    }
    this.#publish();
  }

  async #start(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#core !== null)
      throw new Error("PRP provider thread is already started");
    if (this.options.adoptExistingRunner) {
      // A crash can precede the first driver checkpoint even though runnerd
      // already opened the provider. Exact process adoption must reuse that
      // authority instead of enqueueing another run.prepare/session.open pair.
      await this.#resume();
      return this.#openedThreadResponse(params);
    }
    const token = randomUUID().replaceAll("-", "");
    const identity = this.options.prpIdentity ?? {
      runnerInstanceId: `runner_lab_${token}`,
      environmentLeaseId: `lease_lab_${token}`,
      runId: `run_lab_${token}`,
      normalizedSessionId: `session_lab_${token}`,
      turnId: `turn_lab_${token}`,
      itemId: `item_lab_${token}`,
    };
    const runnerBinaryPath =
      this.options.runnerBinary ?? defaultCapabilityRunnerdBinary();
    const runnerArtifact = approvedRunnerArtifact(runnerBinaryPath);
    this.#durableTurnId = identity.turnId;
    this.#eventIdentity = structuredClone(identity);
    const dynamicTools = Array.isArray(params.dynamicTools)
      ? params.dynamicTools.map(record)
      : [];
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      expectedRunnerVersion: runnerArtifact.version,
      expectedRunnerDigest: runnerArtifact.digest,
      onProtocolIntegrityError: (error) => this.#failTransport(error),
      onSemanticToolInput: (call) => this.#handleSemanticToolInput(call),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    // Externally launched runners own their state directory (for example in a
    // Daytona sandbox). Do not create an empty controller-side placeholder:
    // prior-run authority checks must be able to distinguish absent remote
    // state from malformed direct state.
    if (this.options.runnerStateDirectory === undefined) {
      mkdirSync(resolve(this.#root, "runner"), {
        recursive: true,
        mode: 0o700,
      });
    }
    const provider = this.options.provider ?? "codex";
    const sourceRuntimeContext = this.options.runtimeContext ?? null;
    const runtimeContext =
      this.options.runnerRuntimeContext ?? sourceRuntimeContext;
    const localRuntimeContextPath = resolve(this.#root, "runtime-context.json");
    const runtimeContextPath = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "runtime-context.json")
      : localRuntimeContextPath;
    if (runtimeContext !== null) {
      writeFileSync(
        localRuntimeContextPath,
        `${JSON.stringify(runtimeContext)}\n`,
        { mode: 0o600 },
      );
    }
    const localCodexHome = resolve(this.#root, "codex-home");
    const codexHome = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "codex-home")
      : localCodexHome;
    if (provider === "aws_agentcore") {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    }
    if (provider === "codex") {
      await prepareIsolatedCodexHome({
        context: sourceRuntimeContext,
        codexHome: localCodexHome,
        sourceCodexHome:
          this.options.sourceCodexHome ??
          resolveSourceCodexHome(this.options.environment),
        apiKey:
          this.options.environment?.CODEX_API_KEY ??
          this.options.environment?.OPENAI_API_KEY,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const opencodeProxyPath =
      this.options.opencodeProxyPath ??
      (provider === "opencode" && !this.options.runnerFilesystemRoot
        ? resolveBuildOwnedCliArtifact("opencode-app-server-proxy.cjs")
        : fileURLToPath(
            new URL("../cli/opencode-app-server-proxy.cjs", import.meta.url),
          ));
    const acpxSidecarPath =
      this.options.acpxSidecarPath ??
      (provider === "acpx" && !this.options.runnerFilesystemRoot
        ? resolveBuildOwnedCliArtifact("acpx-runtime-sidecar.cjs")
        : fileURLToPath(
            new URL("../cli/acpx-runtime-sidecar.cjs", import.meta.url),
          ));
    const providerNodeCommand =
      this.options.providerNodeCommand ?? process.execPath;
    const opencodeExecutable =
      provider === "opencode"
        ? (this.options.opencodeCommand ??
          resolve(packageRoot, "node_modules/opencode-ai/bin/opencode.exe"))
        : null;
    const runnerAcpxLaunchProfile =
      provider === "acpx"
        ? acpxRunnerLaunchProfile(
            this.options,
            providerNodeCommand,
            acpxSidecarPath,
          )
        : undefined;
    const runnerOpenCodeLaunchProfile =
      provider === "opencode"
        ? opencodeRunnerLaunchProfile(
            this.options,
            providerNodeCommand,
            opencodeProxyPath,
            opencodeExecutable!,
          )
        : undefined;
    if (
      this.options.runnerFilesystemRoot &&
      (provider === "opencode" || provider === "acpx")
    ) {
      const providerPaths = [
        ["provider Node", providerNodeCommand],
        ["OpenCode proxy", opencodeProxyPath],
        ["ACPX sidecar", acpxSidecarPath],
        ["OpenCode executable", opencodeExecutable ?? "opencode"],
      ] as const;
      for (const [label, candidate] of providerPaths) {
        if (
          candidate.startsWith("/Users/") ||
          /^[A-Za-z]:\\\\Users\\\\/.test(candidate)
        ) {
          throw new Error(
            `runner_remote_provider_artifact_incompatible: ${label} path belongs to the controller host`,
          );
        }
      }
      if (!this.options.providerNodeCommand) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote JS provider omitted its provider-pack Node executable",
        );
      }
      if (provider === "opencode" && !this.options.opencodeProxyPath) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote OpenCode omitted its packaged proxy",
        );
      }
      if (provider === "acpx" && !this.options.acpxSidecarPath) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote ACPX omitted its packaged sidecar",
        );
      }
    }
    this.#authorizedTools = authorizedToolSetForProvider(
      provider,
      dynamicTools,
    );
    const acpxAgent =
      provider === "acpx" ? (this.options.acpxAgent ?? "codex") : null;
    const requestedModel = typeof params.model === "string" ? params.model : "";
    const includeCodexCollaborationInstructions =
      provider === "codex" &&
      record(params.config).include_collaboration_mode_instructions !== false;
    const unboundBaseInstructions = String(
      params.baseInstructions ?? "You are a Paperclip agent.",
    );
    const baseInstructions =
      sourceRuntimeContext && runtimeContext
        ? unboundBaseInstructions.replaceAll(
            sourceRuntimeContext.instructions.bundle.rootPath,
            runtimeContext.instructions.bundle.rootPath,
          )
        : unboundBaseInstructions;
    const acpxProfile =
      provider === "acpx"
        ? resolveQualifiedAcpxProfile(acpxAgent!, requestedModel)
        : null;
    const managedProfile = this.options.managedProfile;
    const agentCoreProfile = this.options.agentCoreProfile;
    if (provider === "claude_managed") {
      if (!managedProfile) {
        throw new Error(
          "Claude Managed runner transport requires a qualified managed profile",
        );
      }
      if (requestedModel !== managedProfile.model) {
        throw new Error(
          "Claude Managed requested model does not match its qualified profile",
        );
      }
    }
    if (provider === "aws_agentcore") {
      if (!agentCoreProfile) {
        throw new Error(
          "AWS AgentCore runner transport requires a qualified AgentCore profile",
        );
      }
      if (requestedModel !== agentCoreProfile.model) {
        throw new Error(
          "AWS AgentCore requested model does not match its qualified profile",
        );
      }
    }
    const completionContract = record(params.completionContract);
    const runAttachTemplate = {
      authorizedTools: this.#authorizedTools,
      ...(completionContract.revision &&
      Array.isArray(completionContract.criterionIds)
        ? { completionContract }
        : {}),
      provider:
        provider === "acpx"
          ? {
              kind: "acpx",
              provider: "acpx",
              driver: "acpx_runtime",
              providerVersion: acpxProfile!.acpxVersion,
              agent: acpxProfile!.agent,
              model: requestedModel,
              acpxVersion: acpxProfile!.acpxVersion,
              agentServerPackage: acpxProfile!.agentServerPackage,
              agentServerVersion: acpxProfile!.agentServerVersion,
              agentRuntimePackage: acpxProfile!.agentRuntimePackage,
              agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
              commandDigest: acpxProfile!.commandDigest,
              sidecarCommand: providerNodeCommand,
              sidecarArgs: [acpxSidecarPath],
              runtimeDirectory:
                this.options.acpxRuntimeDirectory ??
                resolve(this.#root, "acpx"),
              normalizedSessionId: identity.normalizedSessionId,
              runId: identity.runId,
              cwd: String(params.cwd ?? tmpdir()),
              instructions: baseInstructions,
              permissionMode: resolveRunnerdAcpxPermissionMode(
                this.options.acpxPermissionMode,
              ),
              permissionModePinned:
                this.options.acpxPermissionModePinned ?? true,
              runtimeContext,
            }
          : provider === "claude_managed"
            ? {
                kind: "claude_managed",
                model: managedProfile!.model,
                profileId: managedProfile!.profileId,
                anthropicAgentId: managedProfile!.anthropicAgentId,
                agentVersion: managedProfile!.agentVersion,
                environmentId: managedProfile!.environmentId,
                betaVersion: managedProfile!.betaVersion,
                maxSessionListCostUsd: managedProfile!.maxSessionListCostUsd,
                instructions: baseInstructions,
                runtimeContext,
              }
            : provider === "aws_agentcore"
              ? {
                  kind: "aws_agentcore",
                  model: agentCoreProfile!.model,
                  profileId: agentCoreProfile!.profileId,
                  region: agentCoreProfile!.region,
                  accountId: agentCoreProfile!.accountId,
                  harnessArn: agentCoreProfile!.harnessArn,
                  harnessVersion: agentCoreProfile!.harnessVersion,
                  endpointArn: agentCoreProfile!.endpointArn,
                  endpointQualifier: agentCoreProfile!.endpointQualifier,
                  agentRuntimeArn: agentCoreProfile!.agentRuntimeArn,
                  memoryArn: agentCoreProfile!.memoryArn,
                  memoryId: agentCoreProfile!.memoryId,
                  invocationRoleArn: agentCoreProfile!.invocationRoleArn,
                  contextBucket: agentCoreProfile!.contextBucket,
                  contextPrefix: agentCoreProfile!.contextPrefix,
                  contextKmsKeyArn: agentCoreProfile!.contextKmsKeyArn,
                  qualificationRevision:
                    agentCoreProfile!.qualificationRevision,
                  eventExpiryDays: agentCoreProfile!.eventExpiryDays,
                  maxEstimatedSessionCostUsd:
                    agentCoreProfile!.maxEstimatedSessionCostUsd,
                  maxIterations: agentCoreProfile!.maxIterations,
                  maxOutputTokens: agentCoreProfile!.maxOutputTokens,
                  timeoutSeconds: agentCoreProfile!.timeoutSeconds,
                  instructions: baseInstructions,
                  runtimeContext,
                }
              : {
                  kind: provider,
                  provider,
                  driver:
                    provider === "opencode"
                      ? "opencode_server"
                      : "codex_app_server",
                  providerVersion:
                    provider === "opencode" ? "1.18.29" : "codex-app-server-v1",
                  command:
                    provider === "opencode"
                      ? providerNodeCommand
                      : (this.options.codexCommand ?? "codex"),
                  args:
                    provider === "opencode"
                      ? [opencodeProxyPath]
                      : (this.options.codexArgs ??
                        createRunnerdCodexAppServerArgs({
                          environment: this.options.environment,
                          codexHome,
                          codexCommand: this.options.codexCommand,
                          readOnlyRoots: [
                            ...trustedRuntimeReadOnlyRoots(
                              this.options.environment,
                            ),
                            ...(runtimeContext
                              ? [
                                  resolve(codexHome, "skills"),
                                  runtimeContext.instructions.bundle.rootPath,
                                  ...runtimeContext.skills.map(
                                    (skill) => skill.bundle.rootPath,
                                  ),
                                ]
                              : []),
                          ],
                        })),
                  cwd: String(params.cwd ?? tmpdir()),
                  model: typeof params.model === "string" ? params.model : null,
                  approvalPolicy:
                    params.approvalPolicy === "on-request" ||
                    params.approvalPolicy === "untrusted"
                      ? params.approvalPolicy
                      : "never",
                  externallySandboxed:
                    provider === "codex" &&
                    this.options.externallySandboxed === true,
                  instructions:
                    provider === "codex"
                      ? withCodexCollaborationRuntimeInstructions(
                          baseInstructions,
                          includeCodexCollaborationInstructions,
                        )
                      : baseInstructions,
                  collaborationMode:
                    params.permissions ===
                    "paperclip-runner-workspace-read-only"
                      ? "plan"
                      : "default",
                  includeCollaborationModeInstructions:
                    includeCodexCollaborationInstructions,
                  includeSkillInstructions:
                    provider === "codex" && runtimeContext !== null,
                  runtimeContext,
                },
    };
    // Preserve the first generation's provider attachment seed independently
    // of bounded command history. The in-memory copy serves a live warm
    // continuation; the control-plane copy serves a controller/runner resume.
    this.#runAttachTemplate = structuredClone(runAttachTemplate);
    core.persistRunAttachTemplate(runAttachTemplate);
    core.queueCommand("run.prepare", runAttachTemplate);
    core.queueCommand("session.open", { reuse: "same_session" });
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core)
      : null;
    this.#startupFailureCode =
      registration?.startupFailureCode ?? "runner_local_connect_failed";
    if (registration === null) await core.start();
    else {
      this.#controlPlaneCheckpoint = registration.checkpoint ?? null;
      this.#controlPlaneRelease = registration.release;
    }
    const handle = spawnRunner({
      connection: registration?.connection ?? {
        mode: "connect",
        connectUrl: registration?.connectUrl ?? core.connectUrl,
      },
      stateDirectory:
        this.options.runnerStateDirectory ?? resolve(this.#root, "runner"),
      identity,
      ticket: core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
      maxOutboxBytes: RUNNERD_MAX_OUTBOX_BYTES,
      p0ReserveBytes: RUNNERD_P0_RESERVE_BYTES,
      maxRuntimeMs: 0,
      reconnectGraceMs: this.options.runnerReconnectGraceMs,
      lifecyclePolicy: this.options.lifecyclePolicy,
      runnerBinaryPath,
      runnerVersion: runnerArtifact.version,
      runnerDigest: runnerArtifact.digest,
      acpxLaunchProfile: runnerAcpxLaunchProfile,
      opencodeLaunchProfile: runnerOpenCodeLaunchProfile,
      environment: withRunnerdProviderTrace(
        createCapabilityRunnerdProviderEnvironment({
          provider,
          options: {
            ...this.options,
            stateDirectory: this.#root,
            acpxAgent: acpxAgent ?? undefined,
          },
          identity,
          codexHome,
          runtimeContextPath,
          hasRuntimeContext: runtimeContext !== null,
          acpxSidecarPath,
        }),
        this.options.environment,
      ),
      diagnosticsDirectory: resolve(this.#root, "diagnostics"),
      processLauncher: this.options.runnerProcessLauncher,
    });
    this.#handle = handle;
    this.#watchRunner(handle);
    await this.#publishSpawnedProcess(handle);
    await registration?.activate?.();
    if (registration?.failure) {
      void registration.failure.catch((error: unknown) => {
        this.#failTransport(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    await this.#awaitRegistrationReady(registration?.ready);
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = handle.processGroupId ?? null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    await this.#waitCommand("run.prepare");
    await this.#waitCommand("session.open");
    await this.#waitForProviderIdentity();
    this.#startupComplete = true;
    this.#diagnostic("runnerd authenticated to the durable PRP control plane");
    return this.#openedThreadResponse(params);
  }

  #openedThreadResponse(params: Record<string, unknown>): Record<string, unknown> {
    const provider = this.options.provider ?? "codex";
    const acpxAgent = this.options.acpxAgent ?? "codex";
    return {
      thread: {
        id: this.#threadId,
        sessionId: this.#sessionId,
        ...(this.#providerIdentity === null
          ? {}
          : { providerIdentity: structuredClone(this.#providerIdentity) }),
        model: params.model,
        modelProvider:
          provider === "opencode" && typeof params.model === "string"
            ? params.model.split("/", 1)[0]
            : provider === "claude_managed"
              ? "anthropic"
              : provider === "aws_agentcore"
                ? "aws"
                : provider === "acpx"
                  ? acpxAgent === "pi"
                    ? "openrouter"
                    : acpxAgent === "claude"
                      ? "anthropic"
                      : "openai"
                  : "openai",
      },
    };
  }

  async #resume(): Promise<void> {
    const desiredIdentity = this.options.prpIdentity;
    if (desiredIdentity === undefined) {
      throw new Error("PRP provider resume state is unavailable");
    }
    const controlPlaneDirectory = resolve(this.#root, "control-plane");
    const controlPlaneStatePath = resolve(
      controlPlaneDirectory,
      "control-plane-state.json",
    );
    const localProvider =
      this.options.provider === undefined ||
      this.options.provider === "codex" ||
      this.options.provider === "opencode" ||
      this.options.provider === "acpx";
    const localStateOwner =
      this.options.readRunnerState === undefined &&
      this.options.runnerStateDirectory === undefined &&
      this.options.runnerFilesystemRoot === undefined;
    const localRunnerStatePath = resolve(
      this.#root,
      "runner",
      "runner-state.json",
    );
    let candidateRunnerState =
      localStateOwner && existsSync(localRunnerStatePath)
        ? readRunnerState(localRunnerStatePath)
        : null;
    const hasRunnerWarmBoundary =
      candidateRunnerState?.warmTransition !== undefined ||
      candidateRunnerState?.schema ===
        "paperclip.runner.durable.state.warm-transition.v1";
    let controlPlaneState: Record<string, unknown> | null;
    try {
      controlPlaneState = existsSync(controlPlaneStatePath)
        ? readControlPlaneState(controlPlaneDirectory)
        : null;
    } catch (error) {
      if (localProvider && localStateOwner && !hasRunnerWarmBoundary) {
        quarantineLocalRuntimeState(this.#root, error);
      }
      throw error;
    }
    let identity = controlPlaneState
      ? controlPlaneIdentity(controlPlaneState)
      : desiredIdentity;
    if (
      this.options.readRunnerState &&
      controlPlaneState &&
      (controlPlaneState.warmTransition !== undefined ||
        controlPlaneState.schema ===
          "paperclip.runner.durable.control-plane-state.warm-transition.v1" ||
        (Array.isArray(controlPlaneState.commands) &&
          controlPlaneState.commands.some((entry) => {
            const command = record(entry);
            return (
              command.type === "run.attach" &&
              command.status === "pending" &&
              record(command.payload).paperclipNextAuthority !== undefined
            );
          })))
    ) {
      candidateRunnerState = await this.options.readRunnerState();
    }
    let warmRecovery: {
      runnerState: Record<string, unknown>;
      runnerIdentity: DurableRecoveryIdentity;
      transitionId: string;
      commandId: string;
      proof: NonNullable<ReturnType<typeof inspectWarmRunTransition>>;
      port?: number;
    } | null = null;
    const hasWarmBoundary =
      controlPlaneState?.warmTransition !== undefined ||
      controlPlaneState?.schema ===
        "paperclip.runner.durable.control-plane-state.warm-transition.v1" ||
      hasRunnerWarmBoundary ||
      candidateRunnerState?.warmTransition !== undefined ||
      candidateRunnerState?.schema ===
        "paperclip.runner.durable.state.warm-transition.v1";
    if (hasWarmBoundary) {
      // This lane must precede ordinary archive/identity-rebinding recovery.
      // No malformed or unsupported transition is reinterpreted as legacy.
      if (
        (!localStateOwner && !this.options.readRunnerState) ||
        !localProvider ||
        !controlPlaneState ||
        !candidateRunnerState ||
        (this.options.controlPlaneRegistration !== undefined &&
          this.options.warmTransitionRegistrationMode !== "routed_connect") ||
        this.options.adoptExistingRunner !== undefined
      ) {
        throw new Error(
          "native_runner_warm_transition_requires_exact_owned_endpoint",
        );
      }
      const artifact = approvedRunnerArtifact(
        this.options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
      );
      const proof = inspectWarmRunTransition({
        controlPlaneState,
        runnerState: candidateRunnerState,
        expectedNewIdentity: desiredIdentity,
        expectedRunnerVersion: artifact.version,
        expectedRunnerDigest: artifact.digest,
      });
      if (!proof)
        throw new Error("native_runner_warm_transition_snapshot_mismatch");
      const receipt = proof.receipt;
      const connection = receipt.connection;
      const endpoint =
        typeof connection.connectUrl === "string"
          ? new URL(connection.connectUrl)
          : null;
      if (
        connection.mode !== "connect" ||
        endpoint === null ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.username ||
        endpoint.password ||
        (!this.options.controlPlaneRegistration &&
          (endpoint.protocol !== "ws:" ||
            endpoint.hostname !== "127.0.0.1" ||
            endpoint.pathname !== "/durableRecovery/connect" ||
            !endpoint.port))
      ) {
        throw new Error("native_runner_warm_transition_snapshot_mismatch");
      }
      warmRecovery = {
        runnerState: candidateRunnerState,
        runnerIdentity: proof.runnerIdentity,
        proof,
        transitionId: receipt.transitionId,
        commandId: receipt.commandId,
        ...(!this.options.controlPlaneRegistration
          ? { port: Number(endpoint.port) }
          : {}),
      };
      // Fence concurrent public work before exposing the core or awaiting
      // route/materialization hooks, not merely after activation finishes.
      this.#pendingWarmRecoveryCompletion = {
        transitionId: receipt.transitionId,
        identity: structuredClone(desiredIdentity),
      };
    }
    const exactAuthority =
      controlPlaneState !== null &&
      identity.runnerInstanceId === desiredIdentity.runnerInstanceId &&
      identity.environmentLeaseId === desiredIdentity.environmentLeaseId &&
      identity.runId === desiredIdentity.runId &&
      identity.normalizedSessionId === desiredIdentity.normalizedSessionId &&
      identity.turnId === desiredIdentity.turnId &&
      identity.itemId === desiredIdentity.itemId;
    let rotatedAuthority = false;
    if (controlPlaneState === null) {
      if (!localProvider) {
        throw new Error("PRP provider resume state is unavailable");
      }
      const archivedState = latestArchivedControlPlaneState(
        this.#root,
        desiredIdentity,
      );
      if (!archivedState) {
        throw new Error("PRP provider resume state is unavailable");
      }
      if (localStateOwner) {
        try {
          controlPlaneState = rotateLocalAuthorityEpoch(
            this.#root,
            archivedState,
            desiredIdentity,
          );
        } catch (error) {
          quarantineLocalRuntimeState(this.#root, error);
        }
      } else {
        if (
          this.options.readRunnerState === undefined ||
          this.options.archiveExternalRunnerState === undefined
        ) {
          throw new Error("native_runner_prp_run_rotation_unavailable");
        }
        controlPlaneState = await rotateExternalAuthorityEpoch(
          this.#root,
          archivedState,
          desiredIdentity,
          this.options.readRunnerState,
          this.options.archiveExternalRunnerState,
        );
      }
      identity = desiredIdentity;
      rotatedAuthority = true;
    } else if (!exactAuthority && warmRecovery === null) {
      if (!localProvider || controlPlaneState === null) {
        throw new Error("native_runner_prp_run_rotation_unavailable");
      }
      if (localStateOwner) {
        try {
          controlPlaneState = rotateLocalAuthorityEpoch(
            this.#root,
            controlPlaneState,
            desiredIdentity,
          );
        } catch (error) {
          quarantineLocalRuntimeState(this.#root, error);
        }
      } else {
        if (
          this.options.readRunnerState === undefined ||
          this.options.prepareExternalRunnerState === undefined ||
          this.options.archiveExternalRunnerState === undefined
        ) {
          throw new Error("native_runner_prp_run_rotation_unavailable");
        }
        await this.options.prepareExternalRunnerState();
        controlPlaneState = await rotateExternalAuthorityEpoch(
          this.#root,
          controlPlaneState,
          desiredIdentity,
          this.options.readRunnerState,
          this.options.archiveExternalRunnerState,
        );
      }
      identity = desiredIdentity;
      rotatedAuthority = true;
    } else if (
      localStateOwner &&
      !existsSync(resolve(this.#root, "runner", "runner-state.json"))
    ) {
      quarantineLocalRuntimeState(
        this.#root,
        new Error("PRP provider resume state is unavailable"),
      );
    }
    const runnerBinaryPath =
      this.options.runnerBinary ?? defaultCapabilityRunnerdBinary();
    const runnerArtifact = approvedRunnerArtifact(runnerBinaryPath);
    this.#durableTurnId = identity.turnId;
    this.#eventIdentity = structuredClone(identity);
    const provider = this.options.provider ?? "codex";
    const sourceRuntimeContext = this.options.runtimeContext ?? null;
    const runtimeContext =
      this.options.runnerRuntimeContext ?? sourceRuntimeContext;
    const localRuntimeContextPath = resolve(this.#root, "runtime-context.json");
    const runtimeContextPath = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "runtime-context.json")
      : localRuntimeContextPath;
    const localCodexHome = resolve(this.#root, "codex-home");
    const codexHome = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "codex-home")
      : localCodexHome;
    const opencodeProxyPath =
      this.options.opencodeProxyPath ??
      (provider === "opencode" && !this.options.runnerFilesystemRoot
        ? resolveBuildOwnedCliArtifact("opencode-app-server-proxy.cjs")
        : fileURLToPath(
            new URL("../cli/opencode-app-server-proxy.cjs", import.meta.url),
          ));
    const acpxSidecarPath =
      this.options.acpxSidecarPath ??
      (provider === "acpx" && !this.options.runnerFilesystemRoot
        ? resolveBuildOwnedCliArtifact("acpx-runtime-sidecar.cjs")
        : fileURLToPath(
            new URL("../cli/acpx-runtime-sidecar.cjs", import.meta.url),
          ));
    const providerNodeCommand =
      this.options.providerNodeCommand ?? process.execPath;
    const opencodeExecutable =
      provider === "opencode"
        ? (this.options.opencodeCommand ??
          resolve(packageRoot, "node_modules/opencode-ai/bin/opencode.exe"))
        : null;
    const runnerAcpxLaunchProfile =
      provider === "acpx"
        ? acpxRunnerLaunchProfile(
            this.options,
            providerNodeCommand,
            acpxSidecarPath,
          )
        : undefined;
    const runnerOpenCodeLaunchProfile =
      provider === "opencode"
        ? opencodeRunnerLaunchProfile(
            this.options,
            providerNodeCommand,
            opencodeProxyPath,
            opencodeExecutable!,
          )
        : undefined;
    const core = new DurablePrpControlPlane({
      stateDirectory: controlPlaneDirectory,
      identity,
      expectedRunnerVersion: runnerArtifact.version,
      expectedRunnerDigest: runnerArtifact.digest,
      onProtocolIntegrityError: (error) => this.#failTransport(error),
      onSemanticToolInput: (call) => this.#handleSemanticToolInput(call),
      ...(warmRecovery
        ? {
            beforeAuthenticatedConnection: async (admission) => {
              // Core policy already validated the current lease and tuple.
              // Receipt replay still needs the recovery claim, including the
              // completed-core/lost-final-ACK window. Ordinary post-ACK lease
              // reconnects no longer depend on that historical claim.
              if (
                core.store.state.warmTransition?.receipt.transitionId ===
                  warmRecovery.transitionId ||
                admission.warmTransitionId === warmRecovery.transitionId
              ) {
                await this.options.authorizeWarmTransitionRecovery?.(
                  "before_authentication",
                );
              }
            },
          }
        : {}),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    if (rotatedAuthority) {
      const runAttachTemplate = rotatedRunAttachPayload(
        controlPlaneState,
        desiredIdentity,
        this.#authorizedTools,
        this.options.resumeCompletionContract,
      );
      if (provider === "codex") {
        // These controller-owned, token-free paths belong to the new run.
        // Keep the durable provider profile and thread identity unchanged.
        runAttachTemplate.runtimeLaunchArgs =
          this.options.codexArgs ??
          createRunnerdCodexAppServerArgs({
            environment: this.options.environment,
            codexHome,
            codexCommand: this.options.codexCommand,
            readOnlyRoots: [
              ...trustedRuntimeReadOnlyRoots(this.options.environment),
              ...(runtimeContext
                ? [
                    resolve(codexHome, "skills"),
                    runtimeContext.instructions.bundle.rootPath,
                    ...runtimeContext.skills.map(
                      (skill) => skill.bundle.rootPath,
                    ),
                  ]
                : []),
            ],
          });
      }
      this.#runAttachTemplate = structuredClone(runAttachTemplate);
      core.queueCommand("run.attach", runAttachTemplate);
    }
    const committedEvents = core.store.state.committedEvents;
    const runAttachment = recoveredRunAttachment(core.store.state);
    // Reconnecting the exact run authority has no run.attach command to wake
    // provider restoration. Queue a unique, side-effect-free barrier before
    // runnerd starts so every provider backend restores its durable session.
    const recoveryProbeCommandId =
      warmRecovery === null && exactAuthority && runAttachment === null
        ? `command_resume_probe_${randomUUID().replaceAll("-", "")}`
        : null;
    if (recoveryProbeCommandId !== null) {
      core.queueCommand("runner.drain", {}, recoveryProbeCommandId);
    }
    // A controller retry can open the exact authority after run.attach has
    // already reached a durable outcome. Re-observe that command instead of
    // silently waiting for an identity that a failed command can never emit.
    // If attachment completed, replay only its latest identity event into the
    // transport's in-memory evidence; session events are consumed internally
    // and are not duplicated onto the provider notification stream.
    this.#eventSourceSeq =
      runAttachment !== null && runAttachment.providerIdentityEventIndex >= 0
        ? committedEvents[runAttachment.providerIdentityEventIndex]!.sourceSeq -
          1
        : core.store.state.ackedSourceSeq;
    const adoptedProviderIdentityIndex =
      latestProviderIdentityEventIndex(committedEvents);
    if (
      this.options.adoptExistingRunner &&
      exactAuthority &&
      adoptedProviderIdentityIndex >= 0
    ) {
      this.#applyProviderIdentityEvent(
        committedEvents[adoptedProviderIdentityIndex]!,
      );
    } else if (
      (exactAuthority || warmRecovery !== null) &&
      this.options.resumeProviderSession?.driverSessionId.trim() &&
      this.options.resumeProviderSession.providerSessionId?.trim()
    ) {
      this.#threadId = this.options.resumeProviderSession.driverSessionId;
      this.#sessionId = this.options.resumeProviderSession.providerSessionId;
      if (this.options.resumeProviderSession.providerIdentity !== undefined) {
        this.#providerIdentity = record(
          structuredClone(this.options.resumeProviderSession.providerIdentity),
        );
      }
      this.#checkpointProviderIdentityExpectation = {
        driverSessionId: this.#threadId,
        providerSessionId: this.#sessionId,
        providerIdentity:
          this.#providerIdentity === null
            ? null
            : structuredClone(this.#providerIdentity),
      };
      this.#diagnostic(
        this.options.adoptExistingRunner && adoptedProviderIdentityIndex < 0
          ? "restored adopted provider identity from the exact durable checkpoint after PRP event compaction; awaiting live confirmation"
          : "restored provider identity from the exact durable checkpoint; awaiting live confirmation",
      );
    }
    type RecoveryRegistration = Awaited<
      ReturnType<
        NonNullable<
          CapabilityRunnerdCodexTransportOptions["controlPlaneRegistration"]
        >
      >
    >;
    let oldTransitionRegistration: RecoveryRegistration | null = null;
    let newTransitionRegistration: RecoveryRegistration | null = null;
    if (warmRecovery && this.options.controlPlaneRegistration) {
      try {
        oldTransitionRegistration = await this.options.controlPlaneRegistration(
          core,
          warmRecovery.proof.receipt.oldIdentity,
        );
        const oldConnection = oldTransitionRegistration.connection ?? {
          mode: "connect",
          connectUrl: oldTransitionRegistration.connectUrl,
        };
        if (
          oldConnection.mode !== "connect" ||
          typeof oldConnection.connectUrl !== "string"
        ) {
          throw new Error(
            "native_runner_warm_transition_registered_endpoint_mismatch",
          );
        }
        newTransitionRegistration = await this.options.controlPlaneRegistration(
          core,
          warmRecovery.proof.receipt.newIdentity,
        );
        const newConnection = newTransitionRegistration.connection ?? {
          mode: "connect",
          connectUrl: newTransitionRegistration.connectUrl,
        };
        if (
          newConnection.mode !== "connect" ||
          durableRecoveryInternals.canonicalJson(newConnection) !==
            durableRecoveryInternals.canonicalJson(
              warmRecovery.proof.receipt.connection,
            )
        ) {
          throw new Error(
            "native_runner_warm_transition_registered_endpoint_mismatch",
          );
        }
      } catch (error) {
        await Promise.allSettled(
          [oldTransitionRegistration, newTransitionRegistration].map((entry) =>
            Promise.resolve().then(() => entry?.release()),
          ),
        );
        throw error;
      }
    }
    const registration =
      warmRecovery && oldTransitionRegistration && newTransitionRegistration
        ? recoveryIdentityMatches(
            warmRecovery.runnerIdentity,
            warmRecovery.proof.receipt.oldIdentity,
          )
          ? oldTransitionRegistration
          : newTransitionRegistration
        : this.options.controlPlaneRegistration
          ? await this.options.controlPlaneRegistration(core)
          : null;
    this.#startupFailureCode =
      registration?.startupFailureCode ?? "runner_local_connect_failed";
    if (registration === null) await core.start(warmRecovery?.port);
    else {
      this.#controlPlaneCheckpoint = registration.checkpoint ?? null;
      this.#controlPlaneRelease =
        oldTransitionRegistration && newTransitionRegistration
          ? async () => {
              await Promise.all([
                oldTransitionRegistration!.release(),
                newTransitionRegistration!.release(),
              ]);
            }
          : registration.release;
    }
    // Route and immutable endpoint admission precedes every launch-material
    // write. A refused transition leaves its retained home/context untouched.
    if (runtimeContext !== null) {
      writeFileSync(
        localRuntimeContextPath,
        `${JSON.stringify(runtimeContext)}\n`,
        { mode: 0o600 },
      );
    }
    if (provider === "aws_agentcore")
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (provider === "codex") {
      await releaseMaterializedNativeRuntimeSkills(
        resolve(localCodexHome, "skills"),
      );
      await prepareIsolatedCodexHome({
        context: sourceRuntimeContext,
        codexHome: localCodexHome,
        sourceCodexHome:
          this.options.sourceCodexHome ??
          resolveSourceCodexHome(this.options.environment),
        apiKey:
          this.options.environment?.CODEX_API_KEY ??
          this.options.environment?.OPENAI_API_KEY,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const adoptedRunner = this.options.adoptExistingRunner;
    if (warmRecovery) {
      await this.options.authorizeWarmTransitionRecovery?.("before_bootstrap");
    }
    const bootstrapTicket = adoptedRunner
      ? null
      : warmRecovery
        ? core.issueWarmTransitionBootstrapTicket(
            {
              transitionId: warmRecovery.transitionId,
              runnerState: warmRecovery.runnerState,
            },
            RUNNER_BOOTSTRAP_TICKET_TTL_MS,
          )
        : core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS);
    if (warmRecovery) {
      await this.options.authorizeWarmTransitionRecovery?.("before_spawn");
    }
    const handle = adoptedRunner
      ? null
      : spawnRunner({
          connection: registration?.connection ?? {
            mode: "connect",
            connectUrl: registration?.connectUrl ?? core.connectUrl,
          },
          stateDirectory:
            this.options.runnerStateDirectory ?? resolve(this.#root, "runner"),
          identity: warmRecovery?.runnerIdentity ?? identity,
          ticket: bootstrapTicket!,
          maxOutboxBytes: RUNNERD_MAX_OUTBOX_BYTES,
          p0ReserveBytes: RUNNERD_P0_RESERVE_BYTES,
          maxRuntimeMs: 0,
          reconnectGraceMs: this.options.runnerReconnectGraceMs,
          lifecyclePolicy: this.options.lifecyclePolicy,
          runnerBinaryPath,
          runnerVersion: runnerArtifact.version,
          runnerDigest: runnerArtifact.digest,
          acpxLaunchProfile: runnerAcpxLaunchProfile,
          opencodeLaunchProfile: runnerOpenCodeLaunchProfile,
          environment: withRunnerdProviderTrace(
            createCapabilityRunnerdProviderEnvironment({
              provider,
              options: {
                ...this.options,
                stateDirectory: this.#root,
              },
              identity,
              codexHome,
              runtimeContextPath,
              hasRuntimeContext: runtimeContext !== null,
              acpxSidecarPath,
            }),
            this.options.environment,
          ),
          diagnosticsDirectory: resolve(this.#root, "diagnostics"),
          processLauncher: this.options.runnerProcessLauncher,
        });
    if (handle) {
      this.#handle = handle;
      this.#watchRunner(handle);
      await this.#publishSpawnedProcess(handle);
    }
    if (oldTransitionRegistration && newTransitionRegistration) {
      await oldTransitionRegistration.activate?.();
      await newTransitionRegistration.activate?.();
    } else await registration?.activate?.();
    if (registration?.failure) {
      void registration.failure.catch((error: unknown) => {
        this.#failTransport(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    if (!adoptedRunner) await this.#awaitRegistrationReady(registration?.ready);
    if (adoptedRunner) {
      this.#evidence.runnerPid = adoptedRunner.pid;
      this.#evidence.runnerProcessGroupId = adoptedRunner.processGroupId;
      this.#watchAdoptedRunner(adoptedRunner);
    } else {
      this.#evidence.runnerPid = handle?.child.pid ?? null;
      this.#evidence.runnerProcessGroupId = handle?.processGroupId ?? null;
    }
    this.#publish();
    if (warmRecovery) {
      const deadline =
        Date.now() + (this.options.runnerReconnectGraceMs ?? 5_000);
      while (
        !recoveryIdentityMatches(core.store.state.identity, desiredIdentity) ||
        core.store.state.warmTransition !== undefined
      ) {
        if (Date.now() >= deadline || (await this.#runnerHasExited())) {
          throw new Error("native_runner_warm_transition_recovery_pending");
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (core.getCommand(warmRecovery.commandId)?.status !== "completed") {
        throw new Error("native_runner_warm_transition_result_unproven");
      }
      this.#durableTurnId = desiredIdentity.turnId;
      this.#eventIdentity = structuredClone(desiredIdentity);
      this.#eventSourceSeq = 0;
      this.#deferredTurnStartEvents = [];
      if (oldTransitionRegistration && newTransitionRegistration) {
        await oldTransitionRegistration.release();
        this.#controlPlaneRelease = newTransitionRegistration.release;
        this.#controlPlaneCheckpoint =
          newTransitionRegistration.checkpoint ?? null;
      }
    }
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    if (adoptedRunner) {
      await this.#awaitAdoptedRunnerConnection(
        adoptedRunner,
        registration?.ready,
      );
    }
    if (runAttachment) {
      await this.#waitCommand("run.attach", runAttachment.commandId);
    }
    if (recoveryProbeCommandId !== null) {
      await this.#waitCommand("runner.drain", recoveryProbeCommandId);
      if (this.#checkpointProviderIdentityExpectation !== null) {
        // A replacement runner can restore the exact provider while its fresh
        // session.resumed event is compacted or delayed behind the completed
        // recovery barrier. Confirm the live session directly instead of
        // waiting only on the bounded event replay. The authenticated command
        // result is still checked against the exact database checkpoint, so a
        // missing or changed provider identity continues to fail closed.
        const snapshot = await this.#commandResult("session.snapshot", {});
        this.#confirmCheckpointProviderIdentity(
          snapshot,
          "authenticated recovery session.snapshot",
        );
      }
    }
    // A relaunched executor proves its restored provider with either its fresh
    // resume identity or the authenticated snapshot above. An adopted live
    // executor keeps the already-verified provider session, so its
    // authenticated drain plus the committed identity are the corresponding
    // continuity proof.
    await this.#waitForProviderIdentity(
      recoveryProbeCommandId !== null &&
        adoptedRunner === undefined &&
        !this.#checkpointProviderIdentityConfirmed
        ? "session.resumed"
        : undefined,
    );
    this.#startupComplete = true;
    this.#diagnostic(
      rotatedAuthority
        ? "runnerd attached the durable provider session to a fresh PRP run authority"
        : "runnerd restored its durable PRP session and provider thread",
    );
  }

  async #handleSemanticToolInput(
    call: Parameters<
      NonNullable<DurablePrpControlPlaneOptions["onSemanticToolInput"]>
    >[0],
  ) {
    this.#throwIfFailed();
    const core = this.#core;
    const threadId = this.#threadId;
    const epoch = this.#turnStartResponseEpoch;
    const admission = this.#turnStartAdmission;
    // This callback runs independently of the notification pump. Do not copy
    // its provisional turn_lab identity into a provider request before the
    // exact durable command result and matching turn/started bind that turn.
    const accepted =
      admission === null
        ? true
        : await Promise.race([admission.settled, this.#failureSignal]);
    this.#throwIfFailed();
    if (
      !accepted ||
      this.#closed ||
      epoch !== this.#turnStartResponseEpoch ||
      threadId !== this.#threadId ||
      core === null ||
      core !== this.#core ||
      call.correlation.runId !== core.store.state.identity.runId ||
      call.correlation.normalizedSessionId !==
        core.store.state.identity.normalizedSessionId ||
      call.correlation.turnId !== core.store.state.identity.turnId
    ) {
      throw new Error(
        "PRP semantic tool call no longer belongs to an admitted turn",
      );
    }
    return unwrapToolResponse(
      await this.#handler({
        id: call.callId,
        method: "item/tool/call",
        params: {
          threadId,
          turnId: this.#turnId,
          callId: call.callId,
          tool: call.operationId,
          arguments: call.input,
        },
        ...(call.sourceEventId && call.sourceEventType
          ? {
              paperclipTrace: {
                sourceEventId: call.sourceEventId,
                sourceEventType: call.sourceEventType,
              },
            }
          : {}),
      }),
    );
  }

  async #startTurn(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const turnStartTimeoutMs = this.options.turnStartTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(turnStartTimeoutMs) || turnStartTimeoutMs <= 0) {
      throw new Error("turnStartTimeoutMs must be a positive safe integer");
    }
    const commandDeadline = Date.now() + turnStartTimeoutMs;
    const input = Array.isArray(params.input) ? params.input.map(record) : [];
    const message = input
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("\n");
    const pendingTurnId = `turn_lab_${randomUUID().replaceAll("-", "")}`;
    this.#turnId = pendingTurnId;
    const responseEpoch = ++this.#turnStartResponseEpoch;
    this.#turnStartAdmission?.resolve(false);
    let resolveAdmission!: (accepted: boolean) => void;
    this.#turnStartAdmission = {
      settled: new Promise((resolve) => {
        resolveAdmission = resolve;
      }),
      resolve: (accepted) => resolveAdmission(accepted),
    };
    this.#turnStartResponsePending = true;
    let releaseStartResponse!: () => void;
    this.#turnStartResponseSettled = new Promise<void>(resolve => { releaseStartResponse = resolve; });
    this.#expectedProviderTurnId = null;
    let responseReady = false;
    try {
      // Persist a fresh requested identity with the durable command. ACPX uses
      // it as its provider request identity, so a same-run recovery turn cannot
      // alias an already-settled request from the retained provider session.
      // Codex and OpenCode continue to return their provider-assigned identity.
      const startResult = await this.#commandResult(
        "turn.start",
        {
          text: message,
          turnId: pendingTurnId,
        },
        commandDeadline,
      );
      const expectedProviderTurnId =
        typeof startResult.providerTurnId === "string" &&
        startResult.providerTurnId.length > 0
          ? startResult.providerTurnId
          : null;
      if (expectedProviderTurnId === null) {
        const error = new Error(
          "runnerd turn.start omitted its provider turn identity",
        );
        this.#failTransport(error);
        throw error;
      }
      if (
        !turnStartCommandResultValid({
          requestedTurnId: pendingTurnId,
          providerTurnId: expectedProviderTurnId,
          requireRequestedIdentity: this.options.provider === "acpx",
        })
      ) {
        const error = new Error(
          "runnerd ACPX turn.start changed its requested provider turn identity",
        );
        this.#failTransport(error);
        throw error;
      }
      this.#expectedProviderTurnId = expectedProviderTurnId;
      // Command completion only means runnerd accepted the command. Bind the
      // provider turn from the subsequent turn/started event before answering
      // the strict driver. Correlate that event with the exact identity in this
      // command's durable result so a delayed prior-turn event cannot satisfy
      // the new response fence. ACPX echoes the requested identity, while
      // Codex and OpenCode return their provider-assigned identity.
      const deadline =
        this.options.turnStartTimeoutMs === undefined
          ? Date.now() + 30_000
          : commandDeadline;
      const providerTurnStarted = () =>
        turnStartResponseReady({
          responseEpoch,
          observedEpoch: this.#observedTurnStartEpoch,
          expectedProviderTurnId,
          boundTurnId: this.#turnId,
        });
      while (!providerTurnStarted() && Date.now() < deadline) {
        this.#throwIfFailed();
        this.#pumpEvents();
        if (providerTurnStarted()) break;
        if (await this.#runnerHasExited())
          throw new Error("runnerd exited before provider turn startup");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (!providerTurnStarted())
        throw new Error("runnerd did not report the provider turn identity");
      responseReady = true;
      return { turn: { id: this.#turnId, status: "inProgress" } };
    } finally {
      if (!responseReady) {
        resolveAdmission(false);
        if (this.#turnStartResponseEpoch === responseEpoch) {
          this.#turnStartResponsePending = false;
          this.#expectedProviderTurnId = null;
        }
      } else {
        // Resolving this async method schedules the strict driver's response
        // continuation as a microtask. Keep terminal frames held until the
        // following task so the driver can bind and emit turn.accepted first.
        // The epoch prevents a late release from clearing a newer turn fence.
        const release = setTimeout(() => {
          resolveAdmission(
            !this.#closed && this.#turnStartResponseEpoch === responseEpoch,
          );
          if (this.#turnStartResponseEpoch !== responseEpoch) return;
          this.#turnStartResponsePending = false;
          this.#expectedProviderTurnId = null;
          if (!this.#closed) this.#pumpEventsSafely();
        }, 0);
        release.unref();
      }
    }
  }

  async #command(
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = correlationId
      ? `command_steer_${createHash("sha256")
          .update(`${this.#durableTurnId}:${correlationId}`)
          .digest("hex")
          .slice(0, 32)}`
      : `command_lab_${randomUUID().replaceAll("-", "")}`;
    const existing = core.store.state.commands.find(
      (command) => command.commandId === commandId,
    );
    if (existing) {
      if (
        existing.type !== type ||
        durableRecoveryInternals.canonicalJson(existing.payload) !==
          durableRecoveryInternals.canonicalJson(payload)
      ) {
        throw new Error(
          `PRP steering correlation ${correlationId} was reused with different content`,
        );
      }
    } else {
      core.queueCommand(type, payload, commandId, true);
    }
    await this.#waitCommand(type, commandId);
  }

  async #commandResult(
    type: string,
    payload: Record<string, unknown>,
    deadline?: number,
  ): Promise<Record<string, unknown>> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId, deadline);
    const command = core.getCommand(commandId);
    if (command?.status !== "completed" || command.type !== type) {
      throw new Error(`PRP command ${type} omitted its durable result`);
    }
    const result = record(record(command.result).result);
    const completion = this.#pendingWarmRecoveryCompletion;
    if (completion && type === "session.snapshot") {
      const expectation = this.#checkpointProviderIdentityExpectation;
      const providerIdentity = resolveRunnerdSessionIdentity(result);
      if (
        command.type !== "session.snapshot" ||
        core.store.state.warmTransition !== undefined ||
        !recoveryIdentityMatches(
          core.store.state.identity,
          completion.identity,
        ) ||
        core.store.state.completedWarmTransition?.receipt.transitionId !==
          completion.transitionId ||
        expectation === null ||
        providerIdentity.threadId !== expectation.driverSessionId ||
        providerIdentity.sessionId !== expectation.providerSessionId ||
        !["prepared", "session_open", "turn_active"].includes(
          String(result.status),
        )
      ) {
        throw new Error("native_runner_warm_transition_completion_unproven");
      }
      this.#confirmCheckpointProviderIdentity(
        result,
        "fresh post-activation session.snapshot",
      );
      // This newly queued command completed only after runner consumed the
      // final activation ACK. Callback failure retains the completion gate;
      // retry observes a fresh snapshot, never repeats a provider turn.
      const completing = (this.#warmRecoveryCompletionInFlight ??=
        Promise.resolve().then(() =>
          this.options.onWarmTransitionRecoveryCompleted?.({
            transitionId: completion.transitionId,
          }),
        ));
      try {
        await completing;
        if (this.#pendingWarmRecoveryCompletion === completion) {
          this.#pendingWarmRecoveryCompletion = null;
        }
      } finally {
        if (this.#warmRecoveryCompletionInFlight === completing) {
          this.#warmRecoveryCompletionInFlight = null;
        }
      }
    }
    return result;
  }

  async #waitForProviderIdentity(
    expectedEventType?: "harness.ready" | "session.started" | "session.resumed",
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      this.#pumpEvents();
      if (
        this.#threadId.length > 0 &&
        (this.#checkpointProviderIdentityExpectation !== null ||
          this.#evidence.providerExecutionKind === "remote_service" ||
          this.#evidence.providerPid !== null) &&
        (expectedEventType === undefined ||
          this.#providerIdentityEventType === expectedEventType)
      )
        return;
      if (await this.#runnerHasExited())
        throw new Error("runnerd exited before provider startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("runnerd did not report its provider identity");
  }

  async #waitCommand(
    type: string,
    commandId?: string,
    deadline = Date.now() + 30_000,
  ): Promise<void> {
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const command =
        commandId === undefined
          ? this.#core?.store.state.commands.find(
              (candidate) => candidate.type === type,
            )
          : this.#core?.getCommand(commandId);
      if (command?.status === "completed") return;
      if (command !== undefined && command.status !== "pending") {
        throw new Error(
          `PRP command ${type} ${command.status}: ${JSON.stringify(command.result)}`,
        );
      }
      if (await this.#runnerHasExited())
        throw new Error(`runnerd exited while waiting for ${type}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(
      `${this.#startupComplete ? "provider_transport_failed" : this.#startupFailureCode}: PRP command ${type} timed out`,
    );
  }


  #pumpEvents(): void {
    const core = this.#core;
    // The controller may activate its new epoch before attachRun observes the
    // confirmed handoff. Never consume either epoch with the other's cursor.
    if (
      !core ||
      !this.#eventIdentity ||
      !recoveryIdentityMatches(core.store.state.identity, this.#eventIdentity)
    )
      return;
    this.#flushPendingTraceRehydrations();
    const events = core.store.state.committedEvents;
    for (;;) {
      const deferredEvent =
        !this.#recoveryTurnBindingPending &&
        (!this.#turnStartResponsePending || this.#expectedProviderTurnId !== null)
          ? this.#deferredTurnStartEvents[0]
          : undefined;
      const event =
        deferredEvent ??
        events.find((candidate) => candidate.sourceSeq > this.#eventSourceSeq);
      if (event === undefined) return;
      const fromDeferredQueue = deferredEvent !== undefined;
      if (!fromDeferredQueue && event.sourceSeq !== this.#eventSourceSeq + 1) {
        throw new Error(
          `PRP provider event window advanced past source sequence ${this.#eventSourceSeq + 1}`,
        );
      }
      if (this.#recoveryTurnBindingPending && ![
        "harness.ready", "session.started", "session.resumed",
      ].includes(event.eventType)) {
        // Reconnection can deliver mid-turn items before thread/read obtains
        // the authenticated active provider turn. Retain canonical events,
        // not notifications rehydrated with an empty/stale turn identity.
        // Identity events still advance startup; command results are consumed
        // independently, so session.snapshot cannot deadlock behind this gate.
        if (this.#deferredTurnStartEvents.length >= 4_096) {
          throw new Error("recovery produced too many events before its turn binding");
        }
        this.#eventSourceSeq = event.sourceSeq;
        this.#deferredTurnStartEvents.push(structuredClone(event));
        continue;
      }
      const eventPayload = record(event.envelope.payload).payload;
      const turnStartWhileCommandResultPending =
        this.#turnStartResponsePending &&
        this.#expectedProviderTurnId === null &&
        (event.eventType === "turn.started" ||
          (event.eventType === "provider.event" &&
            unwrapRunnerdProviderNotifications(eventPayload).some(
              (notification) => notification.method === "turn/started",
            )));
      // The durable command result is the only correlation authority for a
      // provider-assigned turn id. Copy an early start and its following
      // events out of the control plane's sliding window until that exact
      // expected identity is installed.
      if (
        !fromDeferredQueue &&
        (turnStartWhileCommandResultPending ||
          (this.#turnStartResponsePending &&
            this.#expectedProviderTurnId === null &&
            this.#deferredTurnStartEvents.length > 0))
      ) {
        if (this.#deferredTurnStartEvents.length >= 4_096) {
          throw new Error(
            "turn/start produced too many events before its durable command result",
          );
        }
        this.#eventSourceSeq = event.sourceSeq;
        this.#deferredTurnStartEvents.push(structuredClone(event));
        continue;
      }
      const terminalWhileTurnStartPending =
        this.#turnStartResponsePending &&
        ([
          "turn.completed",
          "turn.failed",
          "turn.interrupted",
          "turn.cancelled",
        ].includes(event.eventType) ||
          (event.eventType === "provider.event" &&
            unwrapRunnerdProviderNotifications(eventPayload).some(
              (notification) => notification.method === "turn/completed",
            )));
      if (terminalWhileTurnStartPending) {
        if (!fromDeferredQueue) {
          this.#eventSourceSeq = event.sourceSeq;
          this.#deferredTurnStartEvents.push(structuredClone(event));
        }
        return;
      }
      // The control plane retains a sliding committed-event window. Track its
      // durable protocol cursor rather than an array index: once that array is
      // full, new events replace its prefix without increasing its length.
      if (fromDeferredQueue) this.#deferredTurnStartEvents.shift();
      else this.#eventSourceSeq = event.sourceSeq;
      if (
        event.eventType === "harness.ready" ||
        event.eventType === "session.started" ||
        event.eventType === "session.resumed"
      ) {
        this.#applyProviderIdentityEvent(event);
        continue;
      }
      if (event.eventType === "harness.diagnostic") {
        const diagnostic = record(record(event.envelope.payload).payload);
        if (
          diagnostic.providerMethod === "acpx/process" &&
          diagnostic.role === "acp_agent" &&
          typeof diagnostic.pid === "number"
        ) {
          this.#evidence.agentPid = diagnostic.pid;
          this.#evidence.agentProcessStartedAt = readLocalProcessStartedAt(
            diagnostic.pid,
          );
          this.#publish();
        }
      }
      if (event.eventType === "runtime_request.created") {
        const request = record(record(event.envelope.payload).payload).request;
        const normalizedRequest = record(request);
        const requestId =
          typeof normalizedRequest.requestId === "string"
            ? normalizedRequest.requestId
            : "";
        const origin = record(normalizedRequest.origin);
        const method = typeof origin.method === "string" ? origin.method : "";
        const params = bridgedCodexQuestionParams(
          normalizedRequest,
          method,
          this.#threadId,
          this.#turnId,
        );
        if (
          requestId &&
          params &&
          (method === "item/tool/requestUserInput" ||
            method === "tool/requestUserInput" ||
            method === "mcpServer/elicitation/request") &&
          !this.#bridgedRuntimeInputs.has(requestId)
        ) {
          this.#bridgedRuntimeInputs.set(requestId, {
            durableTurnId:
              typeof event.envelope.turnId === "string"
                ? event.envelope.turnId
                : this.#durableTurnId,
          });
          void this.#handler({
            id: requestId,
            method,
            params,
            paperclipTrace: {
              sourceEventId: event.sourceEventId,
              sourceEventType: event.eventType,
            },
          }).catch((error) => {
            this.#failTransport(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        }
        continue;
      }
      if (
        event.eventType === "runtime_request.resolved" ||
        event.eventType === "runtime_request.cancelled" ||
        event.eventType === "runtime_request.expired"
      ) {
        const requestId = record(
          record(event.envelope.payload).payload,
        ).requestId;
        if (typeof requestId === "string")
          this.#bridgedRuntimeInputs.delete(requestId);
        continue;
      }
      const sessionUpdatePayload = record(eventPayload);
      const canonicalMethod = runnerdCanonicalNotificationMethod(
        event.eventType,
        sessionUpdatePayload,
      );
      const notifications =
        isCanonicalProviderEventType(event.eventType) && !canonicalMethod
          ? [{ method: "paperclip/canonicalProviderEvent", params: {
              ...(this.#threadId ? { threadId: this.#threadId } : {}),
              ...(this.#turnId ? { turnId: this.#turnId } : {}),
              eventType: event.eventType, payload: eventPayload,
              itemId: event.envelope.itemId,
            } }]
          : event.eventType === "provider.event"
          ? unwrapRunnerdProviderNotifications(eventPayload)
          : canonicalMethod
            ? expandRunnerdCanonicalNotifications(canonicalMethod, eventPayload)
            : [];
      for (const payload of notifications) {
        const method = payload.method;
        if (typeof method !== "string") continue;
        const rawParams = record(payload.params);
        const rawTurn = record(rawParams.turn);
        // Correlate starts only with an explicit provider-native identity.
        // The later rehydration fallback may use the durable controller turn,
        // which is not evidence that the provider accepted this command.
        const explicitProviderTurnId =
          method === "turn/started"
            ? typeof rawParams.providerTurnId === "string" &&
              rawParams.providerTurnId.length > 0
              ? rawParams.providerTurnId
              : typeof rawTurn.id === "string" && rawTurn.id.length > 0
                ? rawTurn.id
                : event.eventType === "provider.event" &&
                    typeof rawParams.turnId === "string" &&
                    rawParams.turnId.length > 0
                  ? rawParams.turnId
                  : null
            : null;
        const params =
          method === "thread/tokenUsage/updated"
            ? rehydrateRunnerdUsageNotification(
                rawParams,
                this.#threadId,
                this.#turnId,
              )
            : method === "turn/plan/updated"
              ? rehydrateRunnerdPlanNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : method === "paperclip/workspaceChange/updated"
              ? rehydrateRunnerdWorkspaceChangeNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : method === "paperclip/runResult"
              ? rehydrateRunnerdResultNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                  typeof event.envelope.itemId === "string"
                    ? event.envelope.itemId
                    : "semantic-result",
                )
            : method === "thread/goal/updated" ||
                method === "thread/goal/cleared"
              ? rehydrateRunnerdGoalNotification(
                  rawParams,
                  this.#threadId,
                  method,
                )
            : event.eventType === "item.delta"
              ? rehydrateRunnerdDeltaNotification(rawParams, this.#threadId, this.#turnId)
            : event.eventType !== "provider.event" &&
                (method === "item/started" || method === "item/completed")
              ? rehydrateRunnerdItemNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : event.eventType !== "provider.event" &&
                (method === "turn/started" || method === "turn/completed")
              ? rehydrateRunnerdTurnNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                  method,
                )
              : rawParams;
        if (
          params.turnId === undefined &&
          typeof event.envelope.turnId === "string" && event.envelope.turnId.length > 0
        ) {
          params.turnId = event.envelope.turnId;
        }
        // Only the canonical start establishes provider turn identity. Other
        // normalized events inherit the durable controller turn from the PRP
        // envelope; allowing one of them to update this binding would replace
        // the provider-native id before its terminal is rehydrated.
        if (method === "turn/started") {
          const providerTurnId = record(params.turn).id ?? params.turnId;
          const disposition = turnStartNotificationDisposition({
            responsePending: this.#turnStartResponsePending,
            expectedProviderTurnId: this.#expectedProviderTurnId,
            observedProviderTurnId: explicitProviderTurnId ?? "",
          });
          if (disposition === "defer") {
            throw new Error(
              "turn/started advanced before its durable command result",
            );
          }
          if (disposition === "reject") {
            const error = new Error(
              "turn/started identity disagreed with its durable command result",
            );
            this.#failTransport(error);
            throw error;
          }
          if (typeof providerTurnId === "string" && providerTurnId.length > 0) {
            this.#turnId = providerTurnId;
            if (this.#turnStartResponsePending) {
              this.#observedTurnStartEpoch = this.#turnStartResponseEpoch;
            }
          }
        }
        this.#queue.push({
          method,
          params,
          ...(this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH
            ? {
                paperclipTrace: {
                  sourceEventId: event.sourceEventId,
                  sourceEventType: event.eventType,
                },
              }
            : {}),
        });
      }
      if (this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH) {
        const pending = {
          sourceEventId: event.sourceEventId,
          eventType: event.eventType,
          visibleNotificationCount: notifications.length,
        };
        const traceResult = appendRunnerdRehydrationTrace(
          this.#traceFrameIndex,
          this.options.environment.PAPERCLIP_PROVIDER_TRACE_PATH,
          pending.sourceEventId,
          pending.eventType,
          pending.visibleNotificationCount,
          this.#nextTraceDebugSequence,
        );
        if (traceResult === "written") {
          this.#nextTraceDebugSequence += 1;
        } else if (
          traceResult === "retry" &&
          this.#pendingTraceRehydrations.length < 4_096
        ) {
          this.#pendingTraceRehydrations.push(pending);
        } else if (traceResult === "retry") {
          this.#traceRehydrationSpoolOverflow = true;
        }
      }
      // The strict Codex driver must bind the provider turn from the response
      // before it observes terminal notifications. A fast provider can commit
      // start and terminal events in one durable batch, so stop after exposing
      // turn/started while the request is pending. The regular pump drains the
      // remaining events after the promise resolves.
      if (
        this.#turnStartResponsePending &&
        notifications.some(
          (notification) => notification.method === "turn/started",
        )
      ) {
        return;
      }
    }
  }

  #applyProviderIdentityEvent(event: DurableRecoveryCommittedEvent): void {
    if (
      event.eventType !== "harness.ready" &&
      event.eventType !== "session.started" &&
      event.eventType !== "session.resumed"
    ) {
      return;
    }
    this.#providerIdentityEventType = event.eventType;
    const started = record(record(event.envelope.payload).payload);
    const runtimeIdentity = record(started.runtimeIdentity);
    const descriptor = record(started.providerDescriptor);
    const {
      processId: pid,
      threadId,
      sessionId,
    } = resolveRunnerdSessionIdentity(started);
    const providerIdentity = record(started.providerIdentity);
    this.#confirmCheckpointProviderIdentity(started, event.eventType);
    if (pid !== null) {
      this.#evidence.providerPid = pid;
      this.#evidence.providerProcessStartedAt = readLocalProcessStartedAt(pid);
      if (descriptor.driver === "acpx_runtime") {
        this.#evidence.sidecarPid = pid;
        this.#evidence.sidecarProcessStartedAt =
          this.#evidence.providerProcessStartedAt;
      } else {
        this.#evidence.codexPid = pid;
        this.#evidence.codexProcessStartedAt =
          this.#evidence.providerProcessStartedAt;
      }
    }
    if (typeof descriptor.driver === "string")
      this.#evidence.providerDriver = descriptor.driver;
    if (typeof descriptor.providerVersion === "string")
      this.#evidence.providerVersion = descriptor.providerVersion;
    if (
      descriptor.agent === "pi" ||
      descriptor.agent === "claude" ||
      descriptor.agent === "codex"
    )
      this.#evidence.acpxAgent = descriptor.agent;
    if (typeof descriptor.agentServerVersion === "string")
      this.#evidence.agentServerVersion = descriptor.agentServerVersion;
    if (typeof descriptor.agentRuntimeVersion === "string")
      this.#evidence.agentRuntimeVersion = descriptor.agentRuntimeVersion;
    if (typeof descriptor.acpProtocolVersion === "number")
      this.#evidence.acpProtocolVersion = descriptor.acpProtocolVersion;
    if (typeof descriptor.agentProcessId === "number") {
      this.#evidence.agentPid = descriptor.agentProcessId;
      this.#evidence.agentProcessStartedAt = readLocalProcessStartedAt(
        descriptor.agentProcessId,
      );
    }
    if (
      runtimeIdentity.executionKind === "local_process" ||
      runtimeIdentity.executionKind === "remote_service"
    ) {
      this.#evidence.providerExecutionKind = runtimeIdentity.executionKind;
    }
    if (runtimeIdentity.service === "anthropic_managed_agents") {
      this.#evidence.providerService = "anthropic_managed_agents";
    } else if (runtimeIdentity.service === "aws_bedrock_agentcore_harness") {
      this.#evidence.providerService = "aws_bedrock_agentcore_harness";
    }
    if (threadId !== null) this.#threadId = threadId;
    if (sessionId !== null) this.#sessionId = sessionId;
    if (typeof providerIdentity.kind === "string") {
      this.#providerIdentity = structuredClone(providerIdentity);
    }
    this.#publish();
  }

  #confirmCheckpointProviderIdentity(input: unknown, source: string): void {
    const checkpointExpectation = this.#checkpointProviderIdentityExpectation;
    if (checkpointExpectation === null) return;
    const { threadId, sessionId } = resolveRunnerdSessionIdentity(input);
    const providerIdentity = record(record(input).providerIdentity);
    if (
      threadId === null &&
      sessionId === null &&
      typeof providerIdentity.kind !== "string"
    ) {
      return;
    }
    const providerIdentityMatches =
      checkpointExpectation.providerIdentity === null ||
      (typeof providerIdentity.kind === "string" &&
        durableRecoveryInternals.canonicalJson(providerIdentity) ===
          durableRecoveryInternals.canonicalJson(
            checkpointExpectation.providerIdentity,
          ));
    const mismatchFields = [
      ...(threadId === checkpointExpectation.driverSessionId
        ? []
        : ["driverSessionId"]),
      ...(sessionId === checkpointExpectation.providerSessionId
        ? []
        : ["providerSessionId"]),
      ...(providerIdentityMatches ? [] : ["providerIdentity"]),
    ];
    if (mismatchFields.length > 0) {
      throw new Error(
        `native_adopted_provider_identity_mismatch: ${source} did not match the exact durable checkpoint (${mismatchFields.join(", ")})`,
      );
    }
    if (this.#checkpointProviderIdentityConfirmed) return;
    this.#checkpointProviderIdentityConfirmed = true;
    this.#diagnostic(`confirmed adopted provider identity against ${source}`);
  }

  #flushPendingTraceRehydrations(): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const retry: PendingTraceRehydration[] = [];
    for (const pending of this.#pendingTraceRehydrations) {
      const traceResult = appendRunnerdRehydrationTrace(
        this.#traceFrameIndex,
        tracePath,
        pending.sourceEventId,
        pending.eventType,
        pending.visibleNotificationCount,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") retry.push(pending);
    }
    this.#pendingTraceRehydrations = retry;

    const driverRetry: PendingDriverTraceInterpretation[] = [];
    for (const pending of this.#pendingDriverTraceInterpretations) {
      const traceResult = appendCodexDriverInterpretationTrace(
        this.#traceFrameIndex,
        tracePath,
        pending,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") driverRetry.push(pending);
    }
    this.#pendingDriverTraceInterpretations = driverRetry;
  }

  #pumpEventsSafely(): void {
    try {
      this.#pumpEvents();
    } catch (error) {
      this.#failTransport(
        new Error(
          `provider_transport_failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  async #runnerHasExited(): Promise<boolean> {
    if (this.#handle) return this.#handle.child.exitCode !== null;
    const adoptedRunner = this.options.adoptExistingRunner;
    if (!adoptedRunner) return true;
    try {
      return !(await adoptedRunner.isAlive());
    } catch {
      return true;
    }
  }

  #watchAdoptedRunner(
    adoptedRunner: NonNullable<
      CapabilityRunnerdCodexTransportOptions["adoptExistingRunner"]
    >,
  ): void {
    let checking = false;
    this.#adoptedRunnerMonitor = setInterval(() => {
      if (checking || this.#closed) return;
      checking = true;
      void Promise.resolve(adoptedRunner.isAlive())
        .then((alive) => {
          if (alive || this.#closed) return;
          this.#evidence.runnerExited = true;
          this.#publish();
          this.#failTransport(
            new Error(
              "native_adopted_runner_exited: the verified runner exited while its durable authority was active",
            ),
          );
        })
        .catch(() => {
          if (!this.#closed) {
            this.#failTransport(
              new Error(
                "native_adopted_runner_identity_unverifiable: runner liveness could not be revalidated",
              ),
            );
          }
        })
        .finally(() => {
          checking = false;
        });
    }, 250);
    this.#adoptedRunnerMonitor.unref?.();
  }

  async #awaitAdoptedRunnerConnection(
    adoptedRunner: NonNullable<
      CapabilityRunnerdCodexTransportOptions["adoptExistingRunner"]
    >,
    ready?: () => Promise<void>,
  ): Promise<void> {
    const core = this.#core;
    if (!core) throw new Error("native_runner_authority_unavailable");
    this.#diagnostic(
      `waiting for adopted runner ${adoptedRunner.pid} to authenticate to its durable PRP authority`,
    );
    try {
      await awaitAdoptedRunnerAuthentication({
        activeConnectionCount: () => core.activeRunnerConnectionCount(),
        isAlive: () => adoptedRunner.isAlive(),
        throwIfFailed: () => this.#throwIfFailed(),
        failure: this.#failureSignal,
        ready,
        timeoutMs: this.options.runnerReconnectGraceMs ?? 30_000,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#failTransport(failure);
      throw failure;
    }
    this.#adoptedRunnerAuthenticated = true;
    this.#diagnostic(
      `adopted runner ${adoptedRunner.pid} authenticated to its durable PRP authority`,
    );
  }

  #watchRunner(handle: RunnerProcessHandle): void {
    void handle.completion.then(
      (result) => {
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        const detail = result.stderr.trim() || result.stdout.trim();
        if (detail) this.#diagnostic(detail.slice(-4_096));
        this.#publish();
        if (this.#closed || this.#failure !== null || this.#handle !== handle)
          return;
        // A per-turn runner exits after its terminal suffix is durably ACKed.
        // Drain that suffix into the provider-facing queue before classifying
        // process completion; clean terminal exit is the expected lifecycle.
        this.#pumpEventsSafely();
        const expectedPerTurnExit =
          result.code === 0 &&
          (this.options.lifecyclePolicy?.mode ?? "per_turn") === "per_turn" &&
          (this.#core?.store.state.committedEvents.some(
            (event) => event.eventType === "runner.suspending",
          ) ??
            false);
        if (expectedPerTurnExit) return;
        const code = /provider_frame_too_large|stdout frame exceeded/i.test(
          detail,
        )
          ? "provider_frame_too_large"
          : /runner_ingress_bind_conflict/i.test(detail)
            ? "runner_ingress_bind_conflict"
            : /transport_reconnect_grace_exceeded/i.test(detail)
              ? "transport_reconnect_grace_exceeded"
              : this.#startupComplete
                ? "native_runner_process_exited"
                : this.#startupFailureCode;
        if (
          code === "native_runner_process_exited" &&
          this.options.runnerReconnectGraceMs !== undefined &&
          handle.restart
        ) {
          void this.#recoverRunnerProcess(handle, detail);
          return;
        }
        this.#failTransport(
          new Error(
            `${code}: runnerd exited unexpectedly${result.code === null ? "" : ` with code ${result.code}`}${detail ? `: ${detail.slice(-1_000)}` : ""}`,
          ),
        );
      },
      (error) => {
        if (this.#closed || this.#failure !== null || this.#handle !== handle)
          return;
        if (
          this.#startupComplete &&
          this.options.runnerReconnectGraceMs !== undefined &&
          handle.restart
        ) {
          void this.#recoverRunnerProcess(
            handle,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        this.#failTransport(
          new Error(
            `${this.#startupComplete ? "native_runner_process_exited" : this.#startupFailureCode}: runnerd process failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );
  }

  async #recoverRunnerProcess(
    failedHandle: RunnerProcessHandle,
    initialDetail: string,
  ): Promise<void> {
    if (
      this.#runnerRecoveryInProgress ||
      this.#closed ||
      this.#failure !== null ||
      this.#handle !== failedHandle ||
      this.#core === null ||
      !failedHandle.restart
    )
      return;
    this.#runnerRecoveryInProgress = true;
    const graceMs = this.options.runnerReconnectGraceMs ?? 0;
    const deadline = Date.now() + graceMs;
    const delays = [250, 500, 1_000, 2_000, 5_000] as const;
    let attempt = 0;
    let restart = failedHandle.restart;
    let lastDetail = initialDetail;
    this.#diagnostic(
      `runner process disconnected; recovery is allowed for ${graceMs}ms`,
    );
    try {
      while (!this.#closed && this.#failure === null && Date.now() < deadline) {
        if (attempt > 0) {
          const base = delays[Math.min(attempt - 1, delays.length - 1)]!;
          const jittered = Math.max(
            1,
            Math.round(base * (0.75 + Math.random() * 0.5)),
          );
          await new Promise((resolveWait) => setTimeout(resolveWait, jittered));
        }
        if (this.#closed || this.#failure !== null) return;
        if (Date.now() >= deadline) break;
        const priorConnectionCount = this.#core.store.state.connectionCount;
        let recoveredHandle: RunnerProcessHandle;
        try {
          recoveredHandle = restart(
            this.#core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
          );
        } catch (error) {
          lastDetail = error instanceof Error ? error.message : String(error);
          attempt += 1;
          continue;
        }
        this.#handle = recoveredHandle;
        if (recoveredHandle.restart) restart = recoveredHandle.restart;
        this.#evidence.runnerExited = false;
        this.#evidence.runnerExitCode = null;
        this.#evidence.runnerSignal = null;
        this.#evidence.runnerPid = recoveredHandle.child.pid ?? null;
        this.#evidence.runnerProcessGroupId =
          recoveredHandle.processGroupId ?? null;
        this.#publish();

        let processSettled = false;
        const completion = recoveredHandle.completion.then(
          (result) => {
            processSettled = true;
            lastDetail = result.stderr.trim() || result.stdout.trim();
            return false;
          },
          (error) => {
            processSettled = true;
            lastDetail = error instanceof Error ? error.message : String(error);
            return false;
          },
        );
        const authenticated = (async () => {
          while (
            !processSettled &&
            !this.#closed &&
            this.#failure === null &&
            Date.now() < deadline
          ) {
            if (
              this.#core !== null &&
              this.#core.store.state.connectionCount > priorConnectionCount &&
              this.#core.activeRunnerConnectionCount() === 1
            )
              return true;
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          return false;
        })();
        if (await Promise.race([completion, authenticated])) {
          this.#diagnostic("runner process restored its durable PRP session");
          this.#watchRunner(recoveredHandle);
          return;
        }
        attempt += 1;
      }
      if (!this.#closed) {
        this.#failTransport(
          new Error(
            `transport_reconnect_grace_exceeded: runner process recovery exceeded ${graceMs}ms${lastDetail ? `: ${lastDetail.slice(-1_000)}` : ""}`,
          ),
        );
      }
    } finally {
      this.#runnerRecoveryInProgress = false;
    }
  }

  #failTransport(error: Error): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = error;
    this.#rejectFailureSignal(error);
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    try {
      this.#diagnostic(error.message);
    } finally {
      // An observer is not allowed to leave notification consumers waiting
      // after the request path has already received this terminal failure.
      this.#queue.close(error);
    }
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  async #awaitRegistrationReady(
    ready: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (ready === undefined) {
      this.#throwIfFailed();
      return;
    }
    await Promise.race([ready(), this.#failureSignal]);
    this.#throwIfFailed();
  }

  #diagnostic(message: string): void {
    this.#evidence.diagnostics.push(message);
    if (this.#evidence.diagnostics.length > 64)
      this.#evidence.diagnostics.shift();
    this.options.onDiagnostic?.(message);
    this.#publish();
  }

  #publish(): void {
    this.options.onEvidence?.(this.evidence());
  }
}

export function defaultCapabilityRunnerdBinary(): string {
  const staged = resolve(
    packageRoot,
    `dist/bin/paperclip-runnerd${executableSuffix}`,
  );
  if (existsSync(staged)) return staged;
  return resolve(
    packageRoot,
    `runner/target/debug/paperclip-runnerd${executableSuffix}`,
  );
}

/** Starts an authenticated durable PRP authority, runnerd, and Codex provider transport. */
export function createCapabilityRunnerdCodexTransport(
  options: CapabilityRunnerdCodexTransportOptions = {},
): CapabilityRunnerdCodexTransport {
  const transport = new DurablePrpCodexTransport(options);
  return {
    transport,
    evidence: () => transport.evidence(),
    detachControllerForRestart: () => transport.detachControllerForRestart(),
  };
}

export const createRunnerdCodexTransport =
  createCapabilityRunnerdCodexTransport;

export const runnerdLaunchProfileInternals = Object.freeze({
  acpxProviderPackageAuthority,
  acpxRunnerLaunchProfile,
  resolveBuildOwnedCliArtifact,
  maxOutboxBytes: RUNNERD_MAX_OUTBOX_BYTES,
  p0ReserveBytes: RUNNERD_P0_RESERVE_BYTES,
});

export const runnerdRecoveryInternals = Object.freeze({
  completedMaintenanceTerminalReceipt,
  completedMaintenanceTerminalReplayMatches,
  awaitProviderDrainBarrier,
  awaitAdoptedRunnerAuthentication,
  awaitRunnerSuspensionBarrier,
  providerDrainStateFromSnapshot,
  providerTurnIsActiveFromCommittedEvents,
  recoveredRunAttachment,
  releaseRunnerProcessOwnership,
  runnerCloseDeadlines,
  rotatedRunAttachPayload,
  rotateExternalAuthorityEpoch,
  turnStartCommandResultValid,
  turnStartNotificationDisposition,
  turnStartResponseReady,
});
