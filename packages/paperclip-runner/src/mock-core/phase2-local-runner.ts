import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  PrpCommand,
  PrpEvent,
  PrpFixture,
  PrpRequest,
  PrpStructuredRunResult,
} from "../protocol/phase1-contract.js";
import {
  validatePrpEvent,
  validatePrpFixture,
} from "../protocol/phase1-contract.js";
import {
  PHASE2_SCENARIOS,
  type Phase2CommandReceipt,
  type Phase2ProcessExitFact,
  type Phase2RunMetadata,
  type Phase2RunTrace,
  type Phase2Scenario,
} from "../contracts/phase2.js";

export {
  PHASE2_SCENARIOS,
  type Phase2CommandReceipt,
  type Phase2ProcessExitFact,
  type Phase2RunMetadata,
  type Phase2RunTrace,
  type Phase2Scenario,
} from "../contracts/phase2.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runnerBinary = resolve(
  packageRoot,
  `runner/target/debug/paperclip-runnerd${executableSuffix}`,
);
const fakeHarnessBinary = resolve(
  packageRoot,
  `runner/target/debug/fake-harness${executableSuffix}`,
);
const scriptRoot = resolve(packageRoot, "protocol/fixtures/phase-02/scripts");

interface RunnerEventMessage {
  kind: "event";
  event: unknown;
}

interface RunnerCommandReceiptMessage {
  kind: "command_receipt";
  commandId: string;
  controllerSeq: number;
  status: Phase2CommandReceipt["status"];
  detail: string;
}

interface RunnerDiagnosticMessage {
  kind: "diagnostic";
  level: string;
  message: string;
}

type RunnerStreamMessage =
  | RunnerEventMessage
  | RunnerCommandReceiptMessage
  | RunnerDiagnosticMessage;

interface RunnerStreamEnvelope {
  schema: "paperclip.runner.stream.v1";
  message: RunnerStreamMessage;
}

interface ReceiptWaiter {
  resolve: (receipt: Phase2CommandReceipt) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  predicate: (event: PrpEvent) => boolean;
  resolve: (event: PrpEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StartPhase2ScenarioOptions {
  scenario: Phase2Scenario;
  delayMs?: number;
  onEvent?: (event: PrpEvent) => void;
  onDiagnostic?: (message: string) => void;
}

export interface RunPhase2ScenarioOptions extends StartPhase2ScenarioOptions {
  duplicateTurnCommand?: boolean;
}

export interface Phase2RunHandle {
  metadata: Phase2RunMetadata;
  completion: Promise<Phase2RunTrace>;
  interrupt(reason?: string): Promise<Phase2CommandReceipt>;
  resolveRequest(
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<Phase2CommandReceipt>;
  waitForEvent(
    predicate: (event: PrpEvent) => boolean,
    timeoutMs?: number,
  ): Promise<PrpEvent>;
  sendDuplicateTurnCommand(): Promise<Phase2CommandReceipt>;
  stop(): void;
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function metadata(scenario: Phase2Scenario): Phase2RunMetadata {
  const suffix = scenario.replaceAll("-", "_");
  return {
    schema: "paperclip.runner.phase2.metadata.v1",
    scenario,
    fixtureName: `Phase 2 ${scenario}`,
    identity: {
      schema: "paperclip.prp.identity.v1",
      companyId: "company_phase2",
      issueId: `issue_phase2_${suffix}`,
      runId: `run_phase2_${suffix}`,
      environmentLeaseId: `lease_phase2_${suffix}`,
      runnerInstanceId: "runner_phase2_local",
      normalizedSessionId: `session_phase2_${suffix}`,
      driverSessionId: "driver_phase2_fake",
    },
    capabilities: {
      schema: "paperclip.prp.capabilities.v1",
      sessionReusePolicy: "new_per_run",
      driver: { kind: "fake", version: "1.0.0" },
      steer: false,
      interrupt: true,
      resume: false,
      runtimeRequests: true,
      structuredResult: true,
      typedEvents: true,
      unsupported: ["steer", "resume"],
    },
  };
}

function processExitFromEvent(event: PrpEvent): Phase2ProcessExitFact | null {
  if (event.eventType !== "harness.exited") {
    return null;
  }
  const processExit = (event.payload as Record<string, unknown>).processExit;
  if (typeof processExit !== "object" || processExit === null) {
    return null;
  }
  const fact = processExit as Record<string, unknown>;
  return {
    exitCode: typeof fact.exitCode === "number" ? fact.exitCode : null,
    success: fact.success === true,
    signal: typeof fact.signal === "number" ? fact.signal : null,
  };
}

class LocalRunnerController implements Phase2RunHandle {
  readonly metadata: Phase2RunMetadata;
  readonly completion: Promise<Phase2RunTrace>;

  #process: ChildProcessWithoutNullStreams;
  #commands: PrpCommand[] = [];
  #receipts: Phase2CommandReceipt[] = [];
  #events: PrpEvent[] = [];
  #requests: PrpRequest[] = [];
  #diagnostics: string[] = [];
  #receiptWaiters = new Map<string, ReceiptWaiter>();
  #eventWaiters: EventWaiter[] = [];
  #nextControllerSeq = 1;
  #turnCommand: PrpCommand | null = null;
  #completionResolve!: (trace: Phase2RunTrace) => void;
  #completionReject!: (error: Error) => void;
  #settled = false;
  #onEvent?: (event: PrpEvent) => void;
  #onDiagnostic?: (message: string) => void;

  private constructor(options: StartPhase2ScenarioOptions) {
    this.metadata = metadata(options.scenario);
    this.#onEvent = options.onEvent;
    this.#onDiagnostic = options.onDiagnostic;
    this.completion = new Promise<Phase2RunTrace>((resolveCompletion, rejectCompletion) => {
      this.#completionResolve = resolveCompletion;
      this.#completionReject = rejectCompletion;
    });

    const scriptPath = resolve(scriptRoot, `${options.scenario}.json`);
    const args = [
      "--run-id",
      this.metadata.identity.runId,
      "--session-id",
      this.metadata.identity.normalizedSessionId,
      "--runner-id",
      this.metadata.identity.runnerInstanceId,
      "--fake-harness",
      fakeHarnessBinary,
      "--script",
      scriptPath,
      "--delay-ms",
      String(options.delayMs ?? 10),
      "--log-max-lines",
      "3",
      "--log-max-bytes",
      "256",
      "--shutdown-grace-ms",
      "75",
    ];
    this.#process = spawn(runnerBinary, args, {
      cwd: packageRoot,
      env: runnerEnvironment(),
      stdio: "pipe",
    });
    createInterface({ input: this.#process.stdout }).on("line", (line) => {
      this.#handleLine(line);
    });
    createInterface({ input: this.#process.stderr }).on("line", (line) => {
      this.#recordDiagnostic(`runner stderr: ${line}`);
    });
    this.#process.on("error", (error) => this.#fail(error));
    this.#process.on("exit", (code, signal) => this.#finish(code, signal));
  }

  static async start(options: StartPhase2ScenarioOptions): Promise<LocalRunnerController> {
    if (!PHASE2_SCENARIOS.includes(options.scenario)) {
      throw new Error(`Unsupported Phase 2 scenario: ${options.scenario}`);
    }
    await Promise.all([access(runnerBinary), access(fakeHarnessBinary)]).catch(() => {
      throw new Error(
        `Phase 2 Rust binaries are missing. Run pnpm --filter @paperclipai/paperclip-runner build:rust first. PATH entries: ${(process.env.PATH ?? "").split(delimiter).length}.`,
      );
    });
    const controller = new LocalRunnerController(options);
    await controller.#initialize();
    return controller;
  }

  async #initialize(): Promise<void> {
    await this.#sendCommand("run.prepare", { workspace: "standalone-fixture" });
    await this.#sendCommand("session.open", { reuse: "new_per_run" });
    this.#turnCommand = this.#makeCommand("turn.start", {
      turnId: `turn_${this.metadata.identity.runId}`,
      text: `Run the ${this.metadata.scenario} fake-driver scenario.`,
    });
    await this.#writeCommand(this.#turnCommand, true);
  }

  async interrupt(reason = "operator_requested"): Promise<Phase2CommandReceipt> {
    return this.#sendCommand("turn.interrupt", {
      turnId: `turn_${this.metadata.identity.runId}`,
      reason,
    });
  }

  async resolveRequest(
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<Phase2CommandReceipt> {
    return this.#sendCommand("request.resolve", { requestId, response });
  }

  waitForEvent(
    predicate: (event: PrpEvent) => boolean,
    timeoutMs = 3_000,
  ): Promise<PrpEvent> {
    const existing = this.#events.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter: EventWaiter = {
        predicate,
        resolve: resolveEvent,
        reject: rejectEvent,
        timer: setTimeout(() => {
          this.#eventWaiters = this.#eventWaiters.filter(
            (candidate) => candidate !== waiter,
          );
          rejectEvent(new Error("Timed out waiting for a Phase 2 runner event"));
        }, timeoutMs),
      };
      this.#eventWaiters.push(waiter);
    });
  }

  async sendDuplicateTurnCommand(): Promise<Phase2CommandReceipt> {
    if (this.#turnCommand === null) {
      throw new Error("turn.start has not been sent");
    }
    return this.#writeCommand(this.#turnCommand, false);
  }

  stop(): void {
    if (!this.#settled) {
      this.#process.stdin.end();
    }
  }

  #makeCommand(type: PrpCommand["type"], payload: Record<string, unknown>): PrpCommand {
    const controllerSeq = this.#nextControllerSeq;
    this.#nextControllerSeq += 1;
    return {
      schema: "paperclip.prp.command.v1",
      commandId: `command_${this.metadata.scenario.replaceAll("-", "_")}_${controllerSeq}`,
      controllerSeq,
      type,
      issuedAt: `2026-08-07T20:45:${String(controllerSeq).padStart(2, "0")}.000Z`,
      payload,
    };
  }

  #sendCommand(
    type: PrpCommand["type"],
    payload: Record<string, unknown>,
  ): Promise<Phase2CommandReceipt> {
    return this.#writeCommand(this.#makeCommand(type, payload), true);
  }

  #writeCommand(
    command: PrpCommand,
    recordCommand: boolean,
  ): Promise<Phase2CommandReceipt> {
    if (
      this.#settled ||
      this.#process.stdin.destroyed ||
      !this.#process.stdin.writable
    ) {
      return Promise.reject(
        new Error("This request expired because the local run already finished. Start a new run."),
      );
    }
    if (recordCommand) {
      this.#commands.push(structuredClone(command));
    }
    return new Promise((resolveReceipt, rejectReceipt) => {
      const timer = setTimeout(() => {
        this.#receiptWaiters.delete(command.commandId);
        rejectReceipt(new Error(`Timed out waiting for ${command.commandId}`));
      }, 3_000);
      this.#receiptWaiters.set(command.commandId, {
        resolve: resolveReceipt,
        reject: rejectReceipt,
        timer,
      });
      this.#process.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#receiptWaiters.delete(command.commandId);
          rejectReceipt(error);
        }
      });
    });
  }

  #handleLine(line: string): void {
    let envelope: RunnerStreamEnvelope;
    try {
      envelope = JSON.parse(line) as RunnerStreamEnvelope;
    } catch (error) {
      this.#fail(new Error(`Runner emitted invalid JSONL: ${String(error)}`));
      return;
    }
    if (envelope.schema !== "paperclip.runner.stream.v1") {
      this.#fail(new Error("Runner emitted an unsupported stream envelope"));
      return;
    }
    const message = envelope.message;
    if (message.kind === "event") {
      const validation = validatePrpEvent(message.event);
      if (!validation.ok) {
        this.#fail(
          new Error(
            `Runner event failed Phase 1 validation: ${validation.issues
              .map((issue) => `${issue.path} ${issue.message}`)
              .join("; ")}`,
          ),
        );
        return;
      }
      this.#events.push(structuredClone(validation.event));
      if (validation.event.eventType === "runtime_request.created") {
        const request = (validation.event.payload as Record<string, unknown>).request;
        if (typeof request === "object" && request !== null) {
          this.#requests.push(structuredClone(request as PrpRequest));
        }
      }
      this.#onEvent?.(validation.event);
      const resolved = this.#eventWaiters.filter((waiter) => waiter.predicate(validation.event));
      this.#eventWaiters = this.#eventWaiters.filter(
        (waiter) => !resolved.includes(waiter),
      );
      for (const waiter of resolved) {
        clearTimeout(waiter.timer);
        waiter.resolve(validation.event);
      }
      return;
    }
    if (message.kind === "command_receipt") {
      const receipt: Phase2CommandReceipt = {
        commandId: message.commandId,
        controllerSeq: message.controllerSeq,
        status: message.status,
        detail: message.detail,
      };
      this.#receipts.push(receipt);
      const waiter = this.#receiptWaiters.get(receipt.commandId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#receiptWaiters.delete(receipt.commandId);
        waiter.resolve(receipt);
      }
      return;
    }
    this.#recordDiagnostic(`${message.level}: ${message.message}`);
  }

  #recordDiagnostic(message: string): void {
    this.#diagnostics.push(message);
    if (this.#diagnostics.length > 16) {
      this.#diagnostics.shift();
    }
    this.#onDiagnostic?.(message);
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#settled) {
      return;
    }
    const resultEvent = this.#events.find((event) => event.eventType === "run.result.proposed");
    const harnessExitEvent = this.#events.find((event) => event.eventType === "harness.exited");
    const trace: Phase2RunTrace = {
      ...this.metadata,
      schema: "paperclip.runner.phase2.trace.v1",
      commands: structuredClone(this.#commands),
      commandReceipts: structuredClone(this.#receipts),
      events: structuredClone(this.#events),
      requests: structuredClone(this.#requests),
      result:
        resultEvent === undefined
          ? null
          : structuredClone(resultEvent.payload as PrpStructuredRunResult),
      harnessProcessExit:
        harnessExitEvent === undefined ? null : processExitFromEvent(harnessExitEvent),
      runnerProcessExit: { code, signal },
      runnerDiagnostics: [...this.#diagnostics],
    };
    const terminalCount = trace.events.filter(
      (event) => event.eventType === "run.terminal",
    ).length;
    if (code !== 0 || terminalCount !== 1) {
      const error = new Error(
        `Phase 2 runner exited with code ${String(code)} and ${terminalCount} terminal events`,
      );
      this.#settled = true;
      this.#completionReject(error);
      return;
    }
    this.#settled = true;
    this.#completionResolve(trace);
  }

  #fail(error: Error): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    for (const waiter of this.#receiptWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of this.#eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#receiptWaiters.clear();
    this.#eventWaiters = [];
    this.#completionReject(error);
    this.#process.stdin.end();
  }
}

export async function startPhase2Scenario(
  options: StartPhase2ScenarioOptions,
): Promise<Phase2RunHandle> {
  return LocalRunnerController.start(options);
}

export async function runPhase2Scenario(
  options: RunPhase2ScenarioOptions,
): Promise<Phase2RunTrace> {
  const handle = await startPhase2Scenario(options);
  if (options.duplicateTurnCommand === true) {
    const receipt = await handle.sendDuplicateTurnCommand();
    if (receipt.status !== "duplicate") {
      handle.stop();
      throw new Error(`Expected duplicate command receipt, got ${receipt.status}`);
    }
  }
  if (options.scenario === "permission-input") {
    await handle.waitForEvent(
      (event) =>
        event.eventType === "runtime_request.created" &&
        (event.payload as Record<string, unknown>).request !== undefined &&
        ((event.payload as Record<string, unknown>).request as Record<string, unknown>)
          .requestId === "request_phase2_permission",
    );
    await handle.resolveRequest("request_phase2_permission", { decision: "allow" });
    await handle.waitForEvent(
      (event) =>
        event.eventType === "runtime_request.created" &&
        ((event.payload as Record<string, unknown>).request as Record<string, unknown>)
          ?.requestId === "request_phase2_input",
    );
    await handle.resolveRequest("request_phase2_input", { text: "phase-02-live-trace" });
  }
  if (options.scenario === "interrupted") {
    await handle.waitForEvent(
      (event) =>
        event.eventType === "item.started" &&
        event.itemId === "item_phase2_long_command",
    );
    await handle.interrupt();
  }
  return handle.completion;
}

export function phase2TraceAsFixture(trace: Phase2RunTrace): PrpFixture {
  if (trace.result === null) {
    throw new Error("A replay fixture requires a structured semantic result");
  }
  const fixture: PrpFixture = {
    schema: "paperclip.prp.fixture.v1",
    fixtureVersion: 1,
    protocolVersion: 1,
    name: trace.fixtureName,
    description: `Live Phase 2 ${trace.scenario} trace captured from paperclip-runnerd.`,
    identity: structuredClone(trace.identity),
    capabilities: structuredClone(trace.capabilities),
    commands: structuredClone(trace.commands),
    events: structuredClone(trace.events),
    requests: structuredClone(trace.requests),
    result: structuredClone(trace.result),
    processFacts: {
      harness: trace.harnessProcessExit,
      runner: trace.runnerProcessExit,
    },
  };
  const validation = validatePrpFixture(fixture);
  if (!validation.ok) {
    throw new Error(
      `Captured Phase 2 trace is not replayable: ${validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return validation.fixture;
}

export const phase2Internals = {
  runnerEnvironment,
};
