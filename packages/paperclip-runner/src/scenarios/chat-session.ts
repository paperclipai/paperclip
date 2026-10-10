import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import type { CapabilityFixtureState } from "../mock-core/capability-control-plane-types.js";
import { CapabilitySemanticToolRuntime } from "../tools/capability-semantic-tool-runtime.js";
import type { CapabilityAuthorizationRecord } from "../tools/capability-semantic-tool-types.js";
import {
  capabilityChatScript,
  type CapabilityChatScript,
  type CapabilityChatStep,
} from "./chat-script.js";
import { capabilityScenarioFixture } from "./scenario-fixtures.js";
import {
  buildExposure,
  CAPABILITY_SECRET_PLACEHOLDER,
  CapabilityExecutionRecorder,
  capabilityIsReconciliationAction,
  snapshotOf,
} from "./scenario-execution.js";
import { capabilityContinuationWakePayload } from "./scenario-runner.js";
import { capabilityFixtureRunCapabilities } from "./fixture-run-capabilities.js";
import {
  capabilityScenarioParity,
  capabilityTurnParity,
  type CapabilityEvalSuiteLookup,
} from "./scenario-parity.js";
import { capabilityStateDiff } from "./state-diff.js";
import type {
  CapabilityChatSessionArtifact,
  CapabilityChatTurn,
  CapabilityExposure,
  CapabilityRunMode,
  CapabilityScenarioIndexEntry,
  CapabilityTimelineEntry,
} from "../scenarios/scenario-explorer-types.js";

/**
 * Scenario chat chat session over the Capability mock control plane.
 *
 * A session is one long-lived mock core that survives across turns, unlike the
 * 7F single-shot run: the board sends a prompt, the scripted agent works, and
 * the state it changed is still there for the next prompt. That accumulation is
 * the whole demo — it is what makes a per-turn diff mean anything.
 *
 * The session decides nothing. It records turn boundaries and asks the existing
 * runtime layers for exposure, authorization, diffs, and verdicts, so the chat
 * UI can group evidence by turn without deriving a single fact itself
 * (7I interaction map §10).
 *
 * No credential, no network, no Paperclip service: the adapter is the in-memory
 * fixture core, and the only prompt text that leaves the page is the text the
 * board typed into this same page.
 */

export interface CapabilityChatSessionOptions {
  mode?: CapabilityRunMode;
  evalSuite?: CapabilityEvalSuiteLookup;
}

export class CapabilityChatSession {
  readonly entry: CapabilityScenarioIndexEntry;
  readonly script: CapabilityChatScript;

  private readonly adapter: CapabilityMockControlPlaneAdapter;
  private readonly runtime: CapabilitySemanticToolRuntime;
  private readonly recorder: CapabilityExecutionRecorder;
  private readonly options: CapabilityChatSessionOptions;
  private readonly context: Awaited<ReturnType<CapabilityMockControlPlaneAdapter["openFixtureRun"]>>;
  private readonly seedState: CapabilityFixtureState;
  private readonly turns: CapabilityChatTurn[] = [];

  private readonly runId: string;
  private turnCursor = 0;
  private authorizationCursor = 0;
  private turnState: CapabilityFixtureState;
  private failure: { message: string } | null = null;
  private closed = false;

  private constructor(init: {
    entry: CapabilityScenarioIndexEntry;
    script: CapabilityChatScript;
    adapter: CapabilityMockControlPlaneAdapter;
    runtime: CapabilitySemanticToolRuntime;
    recorder: CapabilityExecutionRecorder;
    context: Awaited<ReturnType<CapabilityMockControlPlaneAdapter["openFixtureRun"]>>;
    seedState: CapabilityFixtureState;
    options: CapabilityChatSessionOptions;
  }) {
    this.entry = init.entry;
    this.script = init.script;
    this.adapter = init.adapter;
    this.runtime = init.runtime;
    this.recorder = init.recorder;
    this.context = init.context;
    this.seedState = init.seedState;
    this.turnState = init.seedState;
    this.options = init.options;
    this.runId = `run-capability-chat-${init.entry.id}`;
  }

  /**
   * Seeds a session: checkout, wake routing, and the first exposure decision
   * all happen here, as turn 0, before the board can say anything. The demo has
   * to show that work happened with no agent tool involved.
   */
  static async open(
    entry: CapabilityScenarioIndexEntry,
    options: CapabilityChatSessionOptions = {},
  ): Promise<CapabilityChatSession> {
    const fixture = capabilityScenarioFixture(entry);
    const adapter = new CapabilityMockControlPlaneAdapter(fixture.seed);
    return await CapabilityChatSession.openWithMockAdapter(entry, adapter, options);
  }

  /**
   * Server composition seam for the hardened Scenario chat demo.
   *
   * The deployment entrypoint constructs the concrete mock adapter itself and
   * passes that already-selected implementation here. HTTP input, environment
   * variables, and dependency injection cannot select a different adapter.
   */
  static async openWithMockAdapter(
    entry: CapabilityScenarioIndexEntry,
    adapter: CapabilityMockControlPlaneAdapter,
    options: CapabilityChatSessionOptions = {},
  ): Promise<CapabilityChatSession> {
    const mode = options.mode ?? "fake";
    const fixture = capabilityScenarioFixture(entry);
    const script = capabilityChatScript(entry, fixture);
    const runId = `run-capability-chat-${entry.id}`;

    await adapter.start();
    const beforeSeed = snapshotOf(adapter);

    const context = await adapter.openFixtureRun({
      identity: {
        runId,
        sessionId: `session-capability-chat-${entry.id}`,
        companyId: fixture.seed.company!.id!,
        issueId: fixture.taskId,
        agentId: fixture.actorId,
      },
      backendKind: "mock",
      sourceInstanceId: "capability-scenario-chat",
      wake: {
        reason: entry.wakeReason,
        payload: capabilityContinuationWakePayload(entry, fixture, mode),
      },
      capabilities: capabilityFixtureRunCapabilities(entry.scenarioClaims),
    });

    const runtime = new CapabilitySemanticToolRuntime({
      adapter,
      runId,
      scenarioGrants: entry.scenarioClaims,
      policy: entry.policy ?? undefined,
      resolveSecretValue: () => CAPABILITY_SECRET_PLACEHOLDER,
    });

    const recorder = new CapabilityExecutionRecorder({ entry, adapter, runtime });
    recorder.openTurn(0);
    recorder.drainControlPlane();
    const seedState = snapshotOf(adapter);

    const session = new CapabilityChatSession({
      entry,
      script,
      adapter,
      runtime,
      recorder,
      context,
      seedState,
      options,
    });
    session.recordTurn({ turn: 0, prompt: null, before: beforeSeed, after: seedState });
    return session;
  }

  get remainingScriptedTurns(): number {
    return Math.max(this.script.turns.length - this.turnCursor, 0);
  }

  /** The next scripted prompt, offered to the composer as a starting point. */
  nextPrompt(): string | null {
    return this.script.turns[this.turnCursor]?.prompt ?? null;
  }

  /**
   * Runs one turn: the board's message, then the scripted agent work, then
   * whatever the control plane did in response. Every outcome comes from the
   * mock core — a prompt drives the turn, it never dictates the result.
   */
  async send(prompt: string): Promise<CapabilityChatSessionArtifact> {
    if (this.closed) throw new Error("This chat session is closed.");
    const turn = this.turns.length === 0 ? 1 : this.turns[this.turns.length - 1]!.turn + 1;
    const before = snapshotOf(this.adapter);
    this.recorder.openTurn(turn);
    this.recorder.pushUserMessage(prompt);

    const scripted = this.script.turns[this.turnCursor];
    let turnFailure: { message: string } | null = null;
    try {
      if (scripted === undefined) {
        // Past the end of the script the session stays usable rather than
        // pretending the conversation ended: the agent re-reads the task it is
        // checked out on, so the turn still shows real mock activity.
        await this.recorder.runStep({
          kind: "tool_call",
          operationId: "get_task_context",
          input: {},
          summary: "Re-read the task context for an unscripted follow-up turn.",
        });
        this.recorder.pushAgentMessage(
          "The recorded conversation for this scenario is finished. I re-read the task context so this turn still shows what the mock control plane holds; reset the session to replay the script from the seed.",
        );
      } else {
        this.turnCursor += 1;
        for (const step of scripted.steps) {
          await this.runStep(step);
        }
        if (this.script.restraint && this.remainingScriptedTurns === 0) {
          this.recorder.pushRestraintNote(this.entry.forbiddenSemantics.length);
        }
      }
    } catch (error) {
      turnFailure = { message: error instanceof Error ? error.message : String(error) };
      this.failure = turnFailure;
    }

    this.recorder.drainControlPlane();
    const after = snapshotOf(this.adapter);
    this.recordTurn({ turn, prompt, before, after, failure: turnFailure });
    return this.artifact();
  }

  private async runStep(step: CapabilityChatStep): Promise<void> {
    if (step.kind === "control_plane_command") {
      await this.recorder.applyControlPlaneCommand({
        runId: this.runId,
        idempotencyKey: `capability:chat:${this.entry.id}:${step.idempotencySuffix}`,
        command: step.command,
        summary: step.summary,
      });
      return;
    }
    await this.recorder.runStep(step);
  }

  /** Plays every remaining scripted turn — the deterministic `replay=fake` route. */
  async replay(): Promise<CapabilityChatSessionArtifact> {
    while (this.remainingScriptedTurns > 0) {
      const prompt = this.nextPrompt();
      if (prompt === null) break;
      await this.send(prompt);
    }
    return this.artifact();
  }

  artifact(): CapabilityChatSessionArtifact {
    const timeline = [...this.recorder.timeline];
    const authorizationRecords = this.invocationRecords();
    const exposure = this.turns[0]?.exposure ?? this.exposureNow();
    const diff = capabilityStateDiff(this.seedState, this.turnState);
    const parity = capabilityScenarioParity({
      entry: this.entry,
      timeline,
      authorizationRecords,
      diff,
      exposure,
      failure: this.failure,
      evalSuite: this.options.evalSuite,
    });
    return {
      schema: "paperclip.capability.run-artifact.v1",
      scenarioId: this.entry.id,
      mode: this.options.mode ?? "fake",
      runId: this.runId,
      actor: {
        id: this.context.actor.id,
        name: this.context.actor.name,
        role: this.context.actor.role,
        capabilityGrants: [...this.context.actor.capabilityGrants],
      },
      task: {
        id: this.context.activeTask.id,
        identifier: this.context.activeTask.identifier,
        title: this.context.activeTask.title,
        workMode: this.context.activeTask.workMode,
      },
      wake: { reason: this.context.wake.reason, payload: this.context.wake.payload },
      budget: { ...this.context.budget },
      timeline,
      exposure,
      authorizationRecords,
      diff,
      parity,
      failure: this.failure,
      turns: [...this.turns],
      status:
        this.failure !== null
          ? "failed"
          : this.turns.length <= 1
            ? "idle"
            : "settled",
      remainingScriptedTurns: this.remainingScriptedTurns,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.stop();
  }

  private recordTurn(input: {
    turn: number;
    prompt: string | null;
    before: CapabilityFixtureState;
    after: CapabilityFixtureState;
    failure?: { message: string } | null;
  }): void {
    const entries = this.recorder.timeline.filter((item) => item.turn === input.turn);
    const authorizationRecords = this.invocationRecords().slice(this.authorizationCursor);
    this.authorizationCursor += authorizationRecords.length;
    const diff = capabilityStateDiff(input.before, input.after);
    const failure = input.failure ?? null;
    const exposure = this.exposureNow();

    this.turnState = input.after;
    this.turns.push({
      turn: input.turn,
      prompt: input.prompt,
      status: failure === null ? "settled" : "failed",
      firstSequence: entries[0]?.sequence ?? this.recorder.lastSequence,
      lastSequence: entries[entries.length - 1]?.sequence ?? this.recorder.lastSequence,
      exposure,
      authorizationRecords,
      diff,
      reconciliationEvents: reconciliationEvents(entries),
      parity: capabilityTurnParity({
        entry: this.entry,
        timeline: entries,
        authorizationRecords,
        diff,
        exposure,
        failure,
      }),
      counts: {
        calls: entries.filter((item) => item.kind === "semantic_call").length,
        denied: entries.filter(
          (item) =>
            item.kind === "semantic_result" &&
            (item.outcome === "denied" || item.outcome === "absent"),
        ).length,
        controlPlane: entries.filter((item) => item.kind === "control_plane_action").length,
        changedDomains: diff.domains.filter((domain) => domain.changed).length,
      },
      failure,
    });
  }

  /** The exposure decision as it stands now, asked of the authorization engine. */
  private exposureNow(): CapabilityExposure {
    return buildExposure(
      this.runtime.visibleTools().authorizationRecords,
      this.entry.scenarioClaims,
      this.script.controlPlaneCapabilities,
    );
  }

  private invocationRecords(): CapabilityAuthorizationRecord[] {
    return [...this.runtime.authorizationRecords()].filter(
      (record) => record.phase === "invocation",
    );
  }
}

function reconciliationEvents(
  entries: readonly CapabilityTimelineEntry[],
): CapabilityChatTurn["reconciliationEvents"] {
  return entries
    .filter(
      (item): item is Extract<CapabilityTimelineEntry, { kind: "control_plane_action" }> =>
        item.kind === "control_plane_action" && capabilityIsReconciliationAction(item.action),
    )
    .map((item) => ({
      sequence: item.sequence,
      action: item.action,
      summary: item.summary,
      stateRevision: item.stateRevision,
    }));
}

/**
 * Opens a session and plays its whole script — the deterministic artifact the
 * `replay=fake` screenshot routes and the conformance tests consume.
 */
export async function capabilityReplayChatSession(
  entry: CapabilityScenarioIndexEntry,
  options: CapabilityChatSessionOptions = {},
): Promise<CapabilityChatSessionArtifact> {
  const session = await CapabilityChatSession.open(entry, options);
  try {
    return await session.replay();
  } finally {
    await session.close();
  }
}
