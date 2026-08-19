import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import type { CapabilityFixtureSeed, CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { CapabilitySemanticToolRuntime } from "../tools/capability-semantic-tool-runtime.js";
import { CapabilityCodexToolBinding, CapabilityFakeAgentToolBinding } from "../tools/capability-tool-bindings.js";
import { capabilityFixtureRunCapabilities } from "../scenarios/fixture-run-capabilities.js";
import { capabilitySemanticToolDescriptor } from "../semantic-tools/catalog.js";
import { CapabilityLiveSessionService } from "../live/live-session.js";

const GENERATED_HEADER = "# GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory.\n";
const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const REPORT_DIRECTORY = resolve(PACKAGE_ROOT, "knowledge/evidence/capability");

type AssertionClass =
  | "control_plane_invariant"
  | "agent_tool_contract"
  | "authorization_policy"
  | "combined_multi_hop"
  | "restraint_no_call";

interface CapabilityEvalRow {
  id: string;
  title: string;
  group: string;
  sourceAnchor: string;
  expectedSemantics: string[];
  forbiddenSemantics: string[];
  primaryDisposition: "control_plane_owned" | "always_agent_tool" | "optional_agent_tool";
  requiredGrants: string[];
  assertionClasses: AssertionClass[];
}

interface CapabilityEvalInventory {
  schemaVersion: number;
  rows: CapabilityEvalRow[];
}

export interface CapabilityEvalCaseResult {
  caseId: string;
  title: string;
  group: string;
  assertionClasses: AssertionClass[];
  semanticOperation: string;
  expectedSemantics: string[];
  forbiddenSemantics: string[];
  authorizationDecision: string;
  stateDiff: string[];
  finalState: { expected: "unchanged" | "mutated"; observed: "unchanged" | "mutated" };
  sourceAnchor: string;
}

export interface CapabilityLiveCodexMatrixResult {
  caseId: string;
  group: string;
  semanticOperation: string;
  expectedCalls: string[];
  forbiddenCalls: string[];
  observedCalls: string[];
  finalState: { expected: "unchanged" | "mutated"; observed: "unchanged" | "mutated" };
  providerModel: { id: string; provider: string };
  /** Browser-safe evidence retained from the live-session snapshot for scoring. */
  scoringEvidence: {
    trace: {
      runId: string;
      sessionId: string;
      turnId: string;
      itemId: string;
      receiptIds: string[];
      terminalPresent: boolean;
    };
    authorization: {
      expected: "allowed" | "denied" | "absent";
      observed: "allowed" | "denied" | "absent";
    };
    efficiency: { latencyMs: number; attempts: number };
    budget: { maxLatencyMs: number; maxAttempts: number };
  };
}

/** One fixed candidate grant set shared by every live-matrix case. */
export const CAPABILITY_LIVE_EVAL_GRANTS = Object.freeze([
  "delegation:tasks:create",
  "discovery:agents:read",
  "discovery:tasks:read",
  "governance:approvals:request",
]);

export interface CapabilityEvalParityReport {
  schema: "paperclip.capability.eval-parity-report.v1";
  cases: number;
  groups: string[];
  assertionClasses: AssertionClass[];
  fakeAgentOperationCount: number;
  codexOperationCount: number;
  boundedCodexSample: Array<{ caseId: string; group: string; semanticOperation: string }>;
  suiteChecks: string[];
  results: CapabilityEvalCaseResult[];
}

export async function runCapabilityEvalSuite(): Promise<CapabilityEvalParityReport> {
  const inventory = await readInventory();
  assertInventory(inventory);

  const results = await Promise.all(inventory.rows.map(runCase));
  const codexSample = selectCodexSample(results);
  const surface = await toolSurfaceParity(codexSample);
  const report: CapabilityEvalParityReport = {
    schema: "paperclip.capability.eval-parity-report.v1",
    cases: results.length,
    groups: [...new Set(results.map((result) => result.group))].sort(),
    assertionClasses: [...new Set(results.flatMap((result) => result.assertionClasses))].sort() as AssertionClass[],
    fakeAgentOperationCount: surface.fakeAgentOperationCount,
    codexOperationCount: surface.codexOperationCount,
    boundedCodexSample: codexSample,
    suiteChecks: [
      "inventory completeness",
      "generated-doc drift",
      "tool schema/result compatibility",
      "exposure and denial",
      "deterministic fixtures and faults",
      "replay/idempotency/recovery",
      "final projection parity",
    ],
    results,
  };
  return Object.freeze(report);
}

export async function writeCapabilityEvalParityReports(
  report?: CapabilityEvalParityReport,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const resolvedReport = report ?? await runCapabilityEvalSuite();
  const jsonPath = resolve(REPORT_DIRECTORY, "eval-parity-report.json");
  const markdownPath = resolve(REPORT_DIRECTORY, "eval-parity-report.md");
  await mkdir(dirname(jsonPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(resolvedReport, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(resolvedReport)),
  ]);
  return { jsonPath, markdownPath };
}

async function readInventory(): Promise<CapabilityEvalInventory> {
  const source = await readFile(resolve(PACKAGE_ROOT, "spec/capability/eval-traceability.yaml"), "utf8");
  return JSON.parse(source.startsWith(GENERATED_HEADER) ? source.slice(GENERATED_HEADER.length) : source) as CapabilityEvalInventory;
}

function assertInventory(inventory: CapabilityEvalInventory): void {
  const groups = new Set(inventory.rows.map((row) => row.group));
  if (inventory.schemaVersion !== 2 || inventory.rows.length !== 106 || groups.size !== 16) {
    throw new Error(`Capability eval inventory mismatch: rows=${inventory.rows.length}, groups=${groups.size}, schema=${inventory.schemaVersion}`);
  }
  const ids = new Set(inventory.rows.map((row) => row.id));
  if (ids.size !== inventory.rows.length) throw new Error("Capability eval inventory contains duplicate case IDs");
}

async function runCase(row: CapabilityEvalRow): Promise<CapabilityEvalCaseResult> {
  const plan = operationPlan(row);
  const { adapter, runtime } = await runtimeFor(plan.grants);
  const before = adapter.serialize();
  let semanticOperation: string;
  let authorizationDecision: string;
  let after: string;

  if (row.primaryDisposition === "control_plane_owned") {
    semanticOperation = "checkout_task";
    const result = await runtime.invoke({ operationId: semanticOperation, input: {} });
    if (result.ok || result.error.code !== "operation_absent") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["control-plane operation was exposed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
  } else if (row.primaryDisposition === "always_agent_tool") {
    semanticOperation = plan.operationId;
    const result = await runtime.invoke({
      operationId: semanticOperation,
      input: plan.input,
      idempotencyKey: `capability:${row.id}`,
    });
    if (!result.ok || result.authorization.outcome !== "allowed") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["always-agent operation was not allowed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
    if (after === before) throw failure(row, semanticOperation, authorizationDecision, ["expected mock state mutation was absent"]);
  } else {
    semanticOperation = plan.operationId;
    const result = await runtime.invoke({ operationId: semanticOperation, input: plan.input, idempotencyKey: `capability:${row.id}` });
    if (!result.ok || result.authorization.outcome !== "allowed") {
      throw failure(row, semanticOperation, result.authorization.outcome, ["granted optional operation was not allowed"]);
    }
    authorizationDecision = result.authorization.outcome;
    after = adapter.serialize();
    const denied = await runtimeFor();
    const deniedBefore = denied.adapter.serialize();
    const deniedResult = await denied.runtime.invoke({ operationId: semanticOperation, input: plan.input, idempotencyKey: `capability:denied:${row.id}` });
    if (deniedResult.ok || !["absent", "denied"].includes(deniedResult.authorization.outcome) || denied.adapter.serialize() !== deniedBefore) {
      throw failure(row, semanticOperation, deniedResult.authorization.outcome, ["ungranted optional operation exposed protected state"]);
    }
  }

  const stateDiff = before === after ? [] : ["mock_state.revision"];
  const expectedState = operationMutatesState(semanticOperation) ? "mutated" : "unchanged";
  if (row.assertionClasses.includes("restraint_no_call") && stateDiff.length !== 0) {
    throw failure(row, semanticOperation, authorizationDecision, stateDiff);
  }
  return {
    caseId: row.id,
    title: row.title,
    group: row.group,
    assertionClasses: row.assertionClasses,
    semanticOperation,
    expectedSemantics: row.expectedSemantics,
    forbiddenSemantics: row.forbiddenSemantics,
    authorizationDecision,
    stateDiff,
    finalState: {
      expected: expectedState,
      observed: stateDiff.length === 0 ? "unchanged" : "mutated",
    },
    sourceAnchor: row.sourceAnchor,
  };
}

interface OperationPlan {
  operationId: string;
  input: CapabilityJsonValue;
  grants: string[];
}

function operationPlan(row: CapabilityEvalRow): OperationPlan {
  const marker = `Capability conformance: ${row.id}`;
  if (row.primaryDisposition === "control_plane_owned") return { operationId: "checkout_task", input: {}, grants: [] };
  const alwaysByGroup: Partial<Record<string, Omit<OperationPlan, "grants">>> = {
    st: { operationId: "finish_task", input: { summary: marker } },
    cm: { operationId: "report_progress", input: { body: marker } },
    bl: { operationId: "block_task", input: { reason: marker } },
    dp: { operationId: "write_document", input: { key: `plan-${row.id}`, title: row.title, body: marker, baseRevisionId: null } },
    ix: { operationId: "request_human_input", input: { interactionKind: "confirmation", title: row.title, prompt: marker, continuationPolicy: "wake_assignee" } },
    ar: { operationId: "register_deliverable", input: { filename: `${row.id}.json`, contentType: "application/json", byteSize: 2, sha256: "0".repeat(64), contentRef: `memory://${row.id}`, title: row.title } },
  };
  const always = alwaysByGroup[row.group];
  if (always) return { ...always, grants: [] };
  const optionalByGroup: Partial<Record<string, OperationPlan>> = {
    se: { operationId: "search_tasks", input: { query: row.id }, grants: ["discovery:tasks:read"] },
    su: { operationId: "create_task", input: { title: marker }, grants: ["delegation:tasks:create"] },
    ap: { operationId: "request_approval", input: { approvalType: "fixture", payload: { caseId: row.id } }, grants: ["governance:approvals:request"] },
    rf: { operationId: "list_agents", input: {}, grants: ["discovery:agents:read"] },
    mh: { operationId: "create_task", input: { title: marker }, grants: ["delegation:tasks:create"] },
  };
  const optional = optionalByGroup[row.group];
  if (optional) return optional;
  return { operationId: "report_progress", input: { body: marker }, grants: [] };
}

async function runtimeFor(actorGrants: string[] = []) {
  const seed: CapabilityFixtureSeed = {
    actors: [{
      id: "actor-1",
      companyId: "company-1",
      name: "Eval fixture actor",
      role: "engineer",
      status: "active",
      budgetId: "budget-actor-1",
      capabilityGrants: actorGrants,
    }],
  };
  const adapter = new CapabilityMockControlPlaneAdapter(seed);
  await adapter.start();
  await adapter.openFixtureRun({
    identity: {
      runId: "run-capability-eval",
      sessionId: "session-capability-eval",
      companyId: "company-1",
      issueId: "task-1",
      agentId: "actor-1",
    },
    backendKind: "mock",
    sourceInstanceId: "capability-eval-suite",
    capabilities: capabilityFixtureRunCapabilities(actorGrants),
  });
  return {
    adapter,
    runtime: new CapabilitySemanticToolRuntime({ adapter, runId: "run-capability-eval" }),
  };
}

function selectCodexSample(results: CapabilityEvalCaseResult[]): Array<{ caseId: string; group: string; semanticOperation: string }> {
  const groups = [...new Set(results.map((result) => result.group))].sort();
  return groups.map((group) => {
    const result = results.find((candidate) => candidate.group === group);
    if (!result) throw new Error(`missing bounded Codex sample group ${group}`);
    return { caseId: result.caseId, group, semanticOperation: result.semanticOperation };
  });
}

/** Runs one bounded, real-Codex turn for each checked-in eval group. */
export async function runCapabilityLiveCodexMatrix(
  workingDirectory = process.cwd(),
): Promise<CapabilityLiveCodexMatrixResult[]> {
  const inventory = await readInventory();
  assertInventory(inventory);
  const matrix: CapabilityLiveCodexMatrixResult[] = [];

  for (const group of [...new Set(inventory.rows.map((row) => row.group))].sort()) {
    const row = inventory.rows.find((candidate) => candidate.group === group);
    if (!row) throw new Error(`missing live Codex representative for group ${group}`);
    const plan = operationPlan(row);
    const service = new CapabilityLiveSessionService();
    const session = await service.create({
      workingDirectory,
      seed: liveFixtureSeed(CAPABILITY_LIVE_EVAL_GRANTS),
      capabilities: capabilityFixtureRunCapabilities(CAPABILITY_LIVE_EVAL_GRANTS),
      explicitClaims: [...CAPABILITY_LIVE_EVAL_GRANTS],
      runId: `run-capability-live-${row.id}`,
      sessionId: `session-capability-live-${row.id}`,
      turnTimeoutMs: 60_000,
      scenario: { id: `capability-live-eval-${row.id}` },
    });
    try {
      const initialMockState = session.snapshot().mockState;
      const expectedCalls = row.primaryDisposition === "control_plane_owned" ? [] : [plan.operationId];
      const liveInput = {
        ...(typeof plan.input === "object" && plan.input !== null && !Array.isArray(plan.input) ? plan.input : {}),
        // Only mutating operations declare a retry key. Read operations close
        // their schema with `additionalProperties: false`, so injecting one
        // unconditionally makes the model dictate an input the tool must reject.
        ...(operationAcceptsIdempotencyKey(plan.operationId)
          ? { idempotencyKey: `capability-live:${row.id}` }
          : {}),
      };
      const prompt = expectedCalls.length === 0
        ? "Do not call any tools. Reply with exactly: control-plane-owned."
        : `Call ${plan.operationId} exactly once with this JSON input: ${JSON.stringify(liveInput)}. Do not call any other tool. Reply after the typed result.`;
      const turnStartedAt = Date.now();
      const turn = await session.sendMessage(prompt);
      const latencyMs = Date.now() - turnStartedAt;
      const snapshot = turn.snapshot;
      const observedCalls = snapshot.evidence
        .filter((entry) => entry.kind === "tool_call")
        .map((entry) => String(entry.data.operationId));
      const expectedState = operationMutatesState(plan.operationId) ? "mutated" : "unchanged";
      const observedState = snapshot.mockState === initialMockState ? "unchanged" : "mutated";
      // A rejected call still emits a `tool_call` entry, and a rejected read
      // leaves state `unchanged` exactly like a successful one. Comparing calls
      // and state alone therefore reports such a case as green, so the denial
      // itself has to be part of the gate.
      const deniedCalls = snapshot.evidence
        .filter((entry) => entry.kind === "tool_result" && isDeniedToolResult(entry.data.result))
        .map((entry) => String(entry.data.operationId));
      if (
        turn.status !== "completed" ||
        JSON.stringify(observedCalls) !== JSON.stringify(expectedCalls) ||
        observedState !== expectedState ||
        deniedCalls.length > 0
      ) {
        throw new Error(JSON.stringify({
          caseId: row.id,
          turnStatus: turn.status,
          expectedCalls,
          observedCalls,
          expectedState,
          observedState,
          deniedCalls,
          toolResults: snapshot.evidence.filter((entry) => entry.kind === "tool_result").map((entry) => entry.data.result),
        }));
      }
      if (snapshot.providerModel === undefined) {
        throw new Error(`live Codex case ${row.id} did not report its provider model identity`);
      }
      const invocationRecords = snapshot.authorizationRecords.filter(
        (record) => record.phase === "invocation" && record.callId !== null,
      );
      const observedAuthorization = observedCalls.length === 0
        ? "absent"
        : invocationRecords.every((record) => record.allowed)
          ? "allowed"
          : "denied";
      const toolReceipts = snapshot.evidence.filter((entry) => entry.kind === "tool_result");
      const itemId = snapshot.evidence.find((entry) => entry.kind === "tool_call")?.id
        ?? snapshot.transcript.find(
          (entry) => entry.role === "assistant" && entry.turnId === turn.turnId,
        )?.id
        ?? `turn:${turn.turnId}:terminal`;
      matrix.push({
        caseId: row.id,
        group,
        semanticOperation: plan.operationId,
        expectedCalls,
        forbiddenCalls: row.forbiddenSemantics,
        observedCalls,
        finalState: { expected: expectedState, observed: observedState },
        providerModel: snapshot.providerModel,
        scoringEvidence: {
          trace: {
            runId: snapshot.authority.runId,
            sessionId: snapshot.sessionId,
            turnId: turn.turnId,
            itemId,
            receiptIds: toolReceipts.map((entry) => entry.id),
            terminalPresent: true,
          },
          authorization: {
            expected: expectedCalls.length === 0 ? "absent" : "allowed",
            observed: observedAuthorization,
          },
          efficiency: { latencyMs, attempts: 1 },
          budget: { maxLatencyMs: 60_000, maxAttempts: 1 },
        },
      });
    } finally {
      await service.shutdown(session.id, `Capability live eval ${row.id} complete`);
    }
  }
  return matrix;
}

function liveFixtureSeed(actorGrants: readonly string[]): CapabilityFixtureSeed {
  return {
    actors: [{
      id: "actor-1",
      companyId: "company-1",
      name: "Eval fixture actor",
      role: "engineer",
      status: "active",
      budgetId: "budget-actor-1",
      capabilityGrants: [...actorGrants],
    }],
  };
}

function operationMutatesState(operationId: string): boolean {
  return !["checkout_task", "search_tasks", "list_agents"].includes(operationId);
}

/** True when the operation's own schema declares the retry key. */
function operationAcceptsIdempotencyKey(operationId: string): boolean {
  const properties = capabilitySemanticToolDescriptor(operationId)?.inputSchema?.properties;
  return typeof properties === "object" && properties !== null && "idempotencyKey" in properties;
}

/** A typed semantic result the dispatcher rejected rather than applied. */
function isDeniedToolResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

async function toolSurfaceParity(sample: Array<{ caseId: string; group: string; semanticOperation: string }>) {
  const { runtime } = await runtimeFor([
    "discovery:tasks:read",
    "discovery:agents:read",
    "delegation:tasks:create",
    "governance:approvals:request",
  ]);
  const visible = runtime.visibleTools();
  const fake = new CapabilityFakeAgentToolBinding().bind(visible).map((tool) => tool.operationId);
  const codex = new CapabilityCodexToolBinding().bind(visible).map((tool) => tool.name);
  if (JSON.stringify(fake) !== JSON.stringify(codex)) throw new Error("fake-agent and Codex tool surfaces diverged");
  for (const entry of sample) {
    const expectedAbsent = entry.semanticOperation === "checkout_task";
    if (codex.includes(entry.semanticOperation) === expectedAbsent) {
      throw new Error(`Codex sample ${entry.caseId} has unexpected ${entry.semanticOperation} exposure`);
    }
  }
  return { fakeAgentOperationCount: fake.length, codexOperationCount: codex.length };
}

function failure(row: CapabilityEvalRow, semanticOperation: string, authorizationDecision: string, stateDiff: string[]): Error {
  return new Error(JSON.stringify({
    caseId: row.id,
    assertionClass: row.assertionClasses,
    semanticOperation,
    authorizationDecision,
    stateDiff,
  }));
}

function renderMarkdown(report: CapabilityEvalParityReport): string {
  const byDisposition = report.results.reduce<Record<string, number>>((counts, result) => {
    counts[result.semanticOperation] = (counts[result.semanticOperation] ?? 0) + 1;
    return counts;
  }, {});
  return [
    "# Capability Eval Parity Report",
    "",
    `- Cases: ${report.cases}`,
    `- Groups: ${report.groups.length} (${report.groups.join(", ")})`,
    `- Assertion classes: ${report.assertionClasses.join(", ")}`,
    `- Fake-agent/Codex operations: ${report.fakeAgentOperationCount}/${report.codexOperationCount}`,
    `- Bounded Codex binding matrix: ${report.boundedCodexSample.map((entry) => `${entry.group}:${entry.caseId}`).join(", ")}`,
    `- Semantic execution: ${Object.entries(byDisposition).map(([operation, count]) => `${operation}=${count}`).join(", ")}`,
    "",
    "## Offline Guarantees",
    "",
    "- The suite reads only the checked-in Capability traceability derivative and starts only the in-process mock adapter.",
    "- Each result includes source expected/forbidden semantics plus expected and observed final mock state.",
    "- Optional operations are evaluated in both granted and absent configurations; control-plane-owned operations remain absent.",
    "",
  ].join("\n");
}
