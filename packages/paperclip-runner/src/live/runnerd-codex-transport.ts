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
import type {
  HarnessRuntimeRequestResolution,
  PersistedHarnessProviderIdentity,
} from "../contracts/harness-driver.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  spawnRunner,
  waitForProcess,
  type RunnerProcessHandle,
  type RunnerProcessConnection,
  type RunnerProcessLaunchSpec,
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

// URL directory conversion preserves a trailing separator while path-derived
// build artifacts do not. Normalize once so a source build cannot be
// misclassified as an external provider pack by a string-only comparison.
const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const MAX_NOTIFICATION_COUNT = 2_048;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const RUNNER_CLIENT_VERSION = "0.3.0";
const RUNNER_BOOTSTRAP_TICKET_TTL_MS = 60_000;

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
- Invoke the semantic completion tool exactly once before the final assistant response. After it succeeds, send one self-contained final response with the outcome and verification, then do not call another tool.`;

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
  state: Record<string, unknown>,
  desired: DurableRecoveryIdentity,
  authorizedTools: Record<string, unknown> | null,
  completionContract:
    { revision: string; criterionIds: readonly string[] } | undefined,
): Record<string, unknown> {
  const commands = Array.isArray(state.commands)
    ? state.commands.map(record)
    : [];
  const seed = [...commands]
    .reverse()
    .find(
      (command) =>
        (command.type === "run.prepare" || command.type === "run.attach") &&
        record(command.payload).provider !== undefined,
    );
  if (!seed)
    throw new Error("native_runner_authority_rotation_seed_unavailable");
  const payload = structuredClone(record(seed.payload));
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
  const existing = [...input.commands()]
    .reverse()
    .find(
      (command) =>
        command.type === "runner.suspend" && command.status === "pending",
    );
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
    if (command?.status === "completed" && lifecycle === "suspended") {
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
  closeGraceMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<CapabilityRunnerdProcessEvidence>) => void;
  stateDirectory?: string;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  /** Runtime-context paths rewritten for the runner-owned filesystem. */
  runnerRuntimeContext?: NativeRuntimeContextSnapshot | null;
  /** Root path visible to runnerd when it is not on the Paperclip host. */
  runnerFilesystemRoot?: string;
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
  controlPlaneRegistration?: (authority: DurablePrpControlPlane) => Promise<{
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

export function expandRunnerdCanonicalNotifications(
  method: string,
  input: unknown,
): Array<{ method: string; params: Record<string, unknown> }> {
  const payload = record(input);
  if (!Array.isArray(payload.events)) return [{ method, params: payload }];
  return payload.events.map((event) => ({ method, params: record(event) }));
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

type PendingTraceRehydration = {
  sourceEventId: string;
  eventType: string;
  visibleNotificationCount: number;
};

type PendingDriverTraceInterpretation = CodexTraceInterpretation;

function locateRunnerdTraceFrame(
  tracePath: string,
  sourceEventId: string,
): { frameId: number | null; nativeChannelSettled: boolean } {
  const lines = readFileSync(tracePath, "utf8").split("\n");
  let frameId: number | null = null;
  let nativeChannelSettled = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]?.trim()) continue;
    const entry = record(JSON.parse(lines[index]!));
    if (entry.kind === "trace_status" && entry.debugChannel === "rust_native") {
      nativeChannelSettled = true;
    }
    if (
      entry.kind !== "interpretation" ||
      !Array.isArray(entry.emittedEventIds)
    ) {
      continue;
    }
    if ((entry.emittedEventIds as unknown[]).includes(sourceEventId)) {
      frameId = typeof entry.frameId === "number" ? entry.frameId : null;
      break;
    }
  }
  return { frameId, nativeChannelSettled };
}

function appendRunnerdRehydrationTrace(
  tracePath: string | undefined,
  sourceEventId: string,
  eventType: string,
  visibleNotificationCount: number,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
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
  tracePath: string | undefined,
  input: PendingDriverTraceInterpretation,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
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

function acpxProviderPackageAuthority(sidecarScript: string): {
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
  // A local source build consumes pnpm's workspace-owned node_modules tree.
  // A deployed provider pack owns a closed node_modules tree at its own root.
  return sidecarPackageRoot === packageRoot
    ? {
        root: resolve(packageRoot, "../.."),
        manifest: resolve(packageRoot, "package.json"),
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
  #pump: NodeJS.Timeout | null = null;
  #eventIndex = 0;
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
  #turnStartResponseEpoch = 0;
  #observedTurnStartEpoch = 0;
  #expectedProviderTurnId: string | null = null;
  #durableTurnId = "";
  #authorizedTools: Record<string, unknown> | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
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
  #pendingTraceRehydrations: PendingTraceRehydration[] = [];
  #pendingDriverTraceInterpretations: PendingDriverTraceInterpretation[] = [];
  readonly #bridgedRuntimeInputs = new Map<string, { durableTurnId: string }>();

  constructor(readonly options: CapabilityRunnerdCodexTransportOptions) {
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
    if (method === "thread/read") {
      if (this.#core === null) await this.#resume();
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

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
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

  async #stopActiveProviderTurnBeforeSuspend(
    deadline: number,
  ): Promise<boolean> {
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
      return false;
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
        return true;
      }
      if (command !== undefined && command.status !== "pending") {
        this.#diagnostic(
          `provider turn stop ${command.status} before runner suspension`,
        );
        return false;
      }
      if (await this.#runnerHasExited()) return false;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    this.#diagnostic("provider turn stop timed out before runner suspension");
    return false;
  }

  async #drainSettledProviderEventsBeforeSuspend(
    timeoutMs = 1_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let unreadable = false;
    let wakeSequence = 0;
    let crossedDrainBarrier = false;
    while (Date.now() < deadline) {
      const state = this.#providerDrainState();
      if (state === null) return;
      unreadable ||= state === "unreadable";
      if (
        state !== "unreadable" &&
        crossedDrainBarrier &&
        state.pendingEventCount === 0 &&
        state.providerSettled
      )
        return;
      const core = this.#core;
      if (core === null || state === "unreadable") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        continue;
      }
      // runnerd can be blocked waiting for its next command after it ACKs one
      // provider-event prefix. A non-lifecycle drain command wakes another
      // control loop without letting suspend overtake the remaining suffix.
      const commandId = `command_close_drain_${wakeSequence++}_${randomUUID().replaceAll("-", "")}`;
      core.queueCommand("runner.drain", {}, commandId, true);
      while (Date.now() < deadline) {
        this.#pumpEventsSafely();
        const command = core.store.state.commands.find(
          (candidate) => candidate.commandId === commandId,
        );
        if (command?.status === "completed") {
          crossedDrainBarrier = true;
          break;
        }
        if (command !== undefined && command.status !== "pending") {
          this.#diagnostic(
            `provider drain wake ${command.status} before runner suspension`,
          );
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    }
    this.#diagnostic(
      unreadable
        ? "provider state remained unreadable before bounded runner suspension"
        : "provider event backlog did not drain before bounded runner suspension",
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async detachControllerForRestart(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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
    const adoptedRunner = this.options.adoptExistingRunner;
    // `settled` is a durable-state assertion, not merely the absence of a
    // process handle. Registration can install a remote checkpoint callback
    // before process launch; a synchronous launch failure must therefore stay
    // `unsettled` and preserve its original bootstrap diagnostic.
    let runnerSuspended = false;
    let suspensionRequired = false;
    if (
      this.#core !== null &&
      (this.#handle !== null || adoptedRunner !== undefined) &&
      (this.#failure === null || this.#startupComplete)
    ) {
      // A terminal provider frame can become visible one control loop before
      // its durable provider suffix is ACKed. Drain it before suspension so a
      // fresh run authority never inherits the prior run's pending events.
      const closeDeadline = Date.now() + (this.options.closeGraceMs ?? 10_000);
      if (!(await this.#runnerHasExited())) {
        const stoppedActiveTurn =
          await this.#stopActiveProviderTurnBeforeSuspend(closeDeadline);
        await this.#drainSettledProviderEventsBeforeSuspend(
          Math.min(
            stoppedActiveTurn ? 5_000 : 1_000,
            Math.max(0, closeDeadline - Date.now()),
          ),
        );
      }
      suspensionRequired = this.#controlPlaneCheckpoint !== null;
      if (suspensionRequired) {
        runnerSuspended = await awaitRunnerSuspensionBarrier({
          commands: () => this.#core?.store.state.commands ?? [],
          queueSuspend: (commandId) => {
            this.#core?.queueCommand("runner.suspend", {}, commandId, true);
          },
          readRunnerState: () => this.#readDurableRunnerState(),
          runnerHasExited: () => this.#runnerHasExited(),
          pump: () => this.#pumpEventsSafely(),
          deadline: closeDeadline,
        });
        if (!runnerSuspended) {
          this.#diagnostic(
            "runner did not prove durable suspension before checkpoint",
          );
        }
      } else {
        const runnerAlreadyStopping =
          (await this.#runnerHasExited()) ||
          this.#core.store.state.commands.some(
            (command) =>
              (command.type === "runner.suspend" ||
                command.type === "runner.shutdown") &&
              command.status === "pending",
          );
        if (!runnerAlreadyStopping) {
          this.#core.queueCommand("runner.suspend", {}, undefined, true);
        }
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
    try {
      await releaseRunnerProcessOwnership({
        runnerSettled: runnerSuspended,
        checkpoint: this.#controlPlaneCheckpoint,
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
    if (suspensionRequired && !runnerSuspended) {
      throw new Error(
        "provider_transport_failed: runner did not durably suspend before checkpoint",
      );
    }
    if (this.#ownsRoot) rmSync(this.#root, { recursive: true, force: true });
    this.#publish();
  }

  async #start(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#core !== null)
      throw new Error("PRP provider thread is already started");
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
    const dynamicTools = Array.isArray(params.dynamicTools)
      ? params.dynamicTools.map(record)
      : [];
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      expectedRunnerVersion: runnerArtifact.version,
      expectedRunnerDigest: runnerArtifact.digest,
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
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
        ),
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
    core.queueCommand("run.prepare", {
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
                    provider === "opencode" ? "1.18.17" : "codex-app-server-v1",
                  command:
                    provider === "opencode"
                      ? providerNodeCommand
                      : (this.options.codexCommand ?? "codex"),
                  args:
                    provider === "opencode"
                      ? [opencodeProxyPath]
                      : (this.options.codexArgs ??
                        createIsolatedCodexAppServerArgs(
                          this.options.environment,
                          [
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
                        )),
                  cwd: String(params.cwd ?? tmpdir()),
                  model: typeof params.model === "string" ? params.model : null,
                  approvalPolicy:
                    params.approvalPolicy === "on-request" ||
                    params.approvalPolicy === "untrusted"
                      ? params.approvalPolicy
                      : "never",
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
    });
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
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: 60 * 60 * 1_000,
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
    let controlPlaneState: Record<string, unknown> | null;
    try {
      controlPlaneState = existsSync(controlPlaneStatePath)
        ? readControlPlaneState(controlPlaneDirectory)
        : null;
    } catch (error) {
      if (localProvider && localStateOwner) {
        quarantineLocalRuntimeState(this.#root, error);
      }
      throw error;
    }
    let identity = controlPlaneState
      ? controlPlaneIdentity(controlPlaneState)
      : desiredIdentity;
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
    } else if (!exactAuthority) {
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
        {
          mode: 0o600,
        },
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
      // The prior process consumed a sealed, immutable copy. Rebuild that
      // copy from the authoritative runtime snapshot before a new provider is
      // launched; normal materialization still rejects arbitrary replacement.
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
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
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
        ),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    if (rotatedAuthority) {
      core.queueCommand(
        "run.attach",
        rotatedRunAttachPayload(
          controlPlaneState,
          desiredIdentity,
          this.#authorizedTools,
          this.options.resumeCompletionContract,
        ),
      );
    }
    const committedEvents = core.store.state.committedEvents;
    const runAttachment = recoveredRunAttachment(core.store.state);
    // Reconnecting the exact run authority has no run.attach command to wake
    // provider restoration. Queue a unique, side-effect-free barrier before
    // runnerd starts so every provider backend restores its durable session.
    const recoveryProbeCommandId =
      exactAuthority && runAttachment === null
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
    this.#eventIndex =
      runAttachment !== null && runAttachment.providerIdentityEventIndex >= 0
        ? runAttachment.providerIdentityEventIndex
        : committedEvents.length;
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
      exactAuthority &&
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
    const adoptedRunner = this.options.adoptExistingRunner;
    const handle = adoptedRunner
      ? null
      : spawnRunner({
          connection: registration?.connection ?? {
            mode: "connect",
            connectUrl: registration?.connectUrl ?? core.connectUrl,
          },
          stateDirectory:
            this.options.runnerStateDirectory ?? resolve(this.#root, "runner"),
          identity,
          ticket: core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
          maxOutboxBytes: 256 * 1024,
          p0ReserveBytes: 64 * 1024,
          maxRuntimeMs: 60 * 60 * 1_000,
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
    }
    await registration?.activate?.();
    if (registration?.failure) {
      void registration.failure.catch((error: unknown) => {
        this.#failTransport(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    await this.#awaitRegistrationReady(registration?.ready);
    if (adoptedRunner) {
      this.#evidence.runnerPid = adoptedRunner.pid;
      this.#evidence.runnerProcessGroupId = adoptedRunner.processGroupId;
      this.#watchAdoptedRunner(adoptedRunner);
    } else {
      this.#evidence.runnerPid = handle?.child.pid ?? null;
      this.#evidence.runnerProcessGroupId = handle?.processGroupId ?? null;
    }
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    if (adoptedRunner) await this.#awaitAdoptedRunnerConnection(adoptedRunner);
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

  async #startTurn(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = Array.isArray(params.input) ? params.input.map(record) : [];
    const message = input
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("\n");
    const pendingTurnId = `turn_lab_${randomUUID().replaceAll("-", "")}`;
    this.#turnId = pendingTurnId;
    const responseEpoch = ++this.#turnStartResponseEpoch;
    this.#turnStartResponsePending = true;
    this.#expectedProviderTurnId = null;
    let responseReady = false;
    try {
      // Persist a fresh requested identity with the durable command. ACPX uses
      // it as its provider request identity, so a same-run recovery turn cannot
      // alias an already-settled request from the retained provider session.
      // Codex and OpenCode continue to return their provider-assigned identity.
      const startResult = await this.#commandResult("turn.start", {
        text: message,
        turnId: pendingTurnId,
      });
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
      const deadline = Date.now() + 30_000;
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
  ): Promise<Record<string, unknown>> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId);
    const command = core.store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status !== "completed") {
      throw new Error(`PRP command ${type} omitted its durable result`);
    }
    return record(record(command.result).result);
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

  async #waitCommand(type: string, commandId?: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const command = this.#core?.store.state.commands.find((candidate) =>
        commandId === undefined
          ? candidate.type === type
          : candidate.commandId === commandId,
      );
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
    this.#flushPendingTraceRehydrations();
    const events = this.#core?.store.state.committedEvents ?? [];
    while (this.#eventIndex < events.length) {
      const event = events[this.#eventIndex]!;
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
      // provider-assigned turn id. Leave an early start at the cursor until
      // that exact expected identity is installed.
      if (turnStartWhileCommandResultPending) return;
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
      if (terminalWhileTurnStartPending) return;
      this.#eventIndex += 1;
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
      const canonicalMethod = (
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
          "session.updated":
            sessionUpdatePayload.status === "budget_reached"
              ? "provider/budgetReached"
              : "provider/sessionUpdated",
        } as Record<string, string>
      )[event.eventType];
      const notifications =
        event.eventType === "provider.event"
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
                  : event.eventType !== "provider.event" &&
                      (method === "item/started" || method === "item/completed")
                    ? rehydrateRunnerdItemNotification(
                        rawParams,
                        this.#threadId,
                        this.#turnId,
                      )
                    : event.eventType !== "provider.event" &&
                        (method === "turn/started" ||
                          method === "turn/completed")
                      ? rehydrateRunnerdTurnNotification(
                          rawParams,
                          this.#threadId,
                          this.#turnId,
                          method,
                        )
                      : rawParams;
        if (
          params.turnId === undefined &&
          typeof event.envelope.turnId === "string"
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
  ): Promise<void> {
    const core = this.#core;
    if (!core) throw new Error("native_runner_authority_unavailable");
    this.#diagnostic(
      `waiting for adopted runner ${adoptedRunner.pid} to authenticate to its durable PRP authority`,
    );
    while (core.activeRunnerConnectionCount() !== 1) {
      this.#throwIfFailed();
      if (!(await adoptedRunner.isAlive())) {
        throw new Error(
          "native_adopted_runner_exited: runner exited before PRP authentication",
        );
      }
      await Promise.race([
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 25)),
        this.#failureSignal,
      ]);
    }
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
        if (this.#closed || this.#handle !== handle) return;
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
        if (this.#closed || this.#handle !== handle) return;
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
      while (!this.#closed && Date.now() < deadline) {
        if (attempt > 0) {
          const base = delays[Math.min(attempt - 1, delays.length - 1)]!;
          const jittered = Math.max(
            1,
            Math.round(base * (0.75 + Math.random() * 0.5)),
          );
          await new Promise((resolveWait) => setTimeout(resolveWait, jittered));
        }
        if (this.#closed) return;
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
          while (!processSettled && !this.#closed && Date.now() < deadline) {
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
    this.#diagnostic(error.message);
    this.#queue.close(error);
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
});

export const runnerdRecoveryInternals = Object.freeze({
  awaitRunnerSuspensionBarrier,
  providerDrainStateFromSnapshot,
  providerTurnIsActiveFromCommittedEvents,
  recoveredRunAttachment,
  releaseRunnerProcessOwnership,
  rotateExternalAuthorityEpoch,
  turnStartCommandResultValid,
  turnStartNotificationDisposition,
  turnStartResponseReady,
});
