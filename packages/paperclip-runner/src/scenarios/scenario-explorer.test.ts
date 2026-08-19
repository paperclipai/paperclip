import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import { CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS } from "../tools/capability-semantic-tool-types.js";
import {
  buildCapabilityScenarioIndex,
  capabilityScenarioEntry,
  capabilityScenarioProfileCoverage,
} from "./scenario-index.js";
import { capabilityScenarioFixture } from "./scenario-fixtures.js";
import { capabilityScenarioPlan } from "./scenario-plan.js";
import { capabilityEvalSuiteLookup } from "./scenario-parity.js";
import { capabilityRunScenario } from "./scenario-runner.js";
import type { CapabilityScenarioIndex, CapabilityScenarioIndexEntry } from "../scenarios/scenario-explorer-types.js";

const MANIFEST_PATH = resolve(import.meta.dirname, "../../spec/capability/eval-traceability.yaml");

/** The twelve UX acceptance scenarios from the interaction map §9. */
const ACCEPTANCE_CASES = [
  "hb-scoped-wake-01",
  "wk-plan-directive-01",
  "bl-create-blocked-01",
  "ap-mcp-gate-01",
  "ar-upload-before-done-01",
  "ix-checkbox-01",
  "rf-api-mgr-heartbeat-01",
  "mh-subtask-tree-01",
  "rs-question-only-01",
  "rs-secret-hygiene-01",
];

let index: CapabilityScenarioIndex;

beforeAll(async () => {
  index = buildCapabilityScenarioIndex(await readFile(MANIFEST_PATH, "utf8"));
});

function entryFor(id: string): CapabilityScenarioIndexEntry {
  const entry = capabilityScenarioEntry(index, id);
  expect(entry, `scenario ${id} is missing from the index`).toBeDefined();
  return entry!;
}

describe("capability scenario index", () => {
  it("covers all 106 eval cases across the 16 groups", () => {
    expect(index.entries).toHaveLength(106);
    expect(index.groups).toHaveLength(16);
    expect(index.groups.reduce((total, group) => total + group.count, 0)).toBe(106);
  });

  it("declares an actor role, task mode, and seed for every scenario", () => {
    for (const entry of index.entries) {
      expect(["engineer", "manager", "reviewer", "board"]).toContain(entry.actorRole);
      expect(["standard", "ask", "planning", "skill_test"]).toContain(entry.taskMode);
      expect(entry.seedKind.length).toBeGreaterThan(0);
    }
  });

  it("declares a profile for every fixture the manifest names", () => {
    const declared = new Set(capabilityScenarioProfileCoverage());
    const referenced = new Set(index.entries.map((entry) => entry.fixture));
    expect([...referenced].filter((fixture) => !declared.has(fixture))).toEqual([]);
  });

  it("is deterministic across two builds", async () => {
    const source = await readFile(MANIFEST_PATH, "utf8");
    expect(JSON.stringify(buildCapabilityScenarioIndex(source))).toBe(
      JSON.stringify(buildCapabilityScenarioIndex(source)),
    );
  });
});

describe("capability scenario plans", () => {
  it("plans only operations the semantic catalog defines", () => {
    const catalog = new Set(CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => tool.operationId));
    for (const entry of index.entries) {
      const plan = capabilityScenarioPlan(entry, capabilityScenarioFixture(entry));
      for (const step of plan.steps) {
        if (step.kind !== "tool_call") continue;
        expect(catalog, `${entry.id} plans unknown operation ${step.operationId}`).toContain(
          step.operationId,
        );
      }
    }
  });

  it("never plans a control-plane-owned capability as an agent tool", () => {
    const controlPlane = new Set<string>(CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS);
    for (const entry of index.entries) {
      const plan = capabilityScenarioPlan(entry, capabilityScenarioFixture(entry));
      for (const step of plan.steps) {
        if (step.kind !== "tool_call") continue;
        expect(controlPlane.has(step.operationId)).toBe(false);
      }
      for (const capability of plan.controlPlaneCapabilities) {
        expect(controlPlane.has(capability.operationId)).toBe(true);
      }
    }
  });
});

describe("capability scenario runs", () => {
  it("renders every scenario with exposure, control plane, authorization, diff, and parity", async () => {
    const artifacts = await Promise.all(
      index.entries.map((entry) => capabilityRunScenario(entry)),
    );
    for (const artifact of artifacts) {
      expect(artifact.failure, `${artifact.scenarioId} failed to run`).toBeNull();
      expect(artifact.exposure.always.length).toBeGreaterThan(0);
      expect(
        artifact.timeline.some((item) => item.kind === "control_plane_action"),
        `${artifact.scenarioId} recorded no control-plane action`,
      ).toBe(true);
      expect(artifact.authorizationRecords.length).toBeGreaterThan(0);
      expect(artifact.diff.domains).toHaveLength(10);
      expect(["pass", "fail", "intentional_gap", "not_run"]).toContain(artifact.parity.verdict);
    }
  }, 60_000);

  it("passes parity for every scenario", async () => {
    const artifacts = await Promise.all(index.entries.map((entry) => capabilityRunScenario(entry)));
    const failures = artifacts
      .filter((artifact) => artifact.parity.verdict === "fail")
      .map((artifact) => ({
        scenario: artifact.scenarioId,
        failed: artifact.parity.assertions.filter((assertion) => assertion.status === "fail"),
      }));
    expect(failures).toEqual([]);
  }, 60_000);

  it("produces byte-identical artifacts for two runs of the same scenario", async () => {
    for (const id of ACCEPTANCE_CASES) {
      const entry = entryFor(id);
      const [first, second] = await Promise.all([
        capabilityRunScenario(entry),
        capabilityRunScenario(entry),
      ]);
      expect(JSON.stringify(second), `${id} is not deterministic`).toBe(JSON.stringify(first));
    }
  }, 60_000);

  it("uses fixture time only — no wall-clock instant appears in a fake run", async () => {
    const artifact = await capabilityRunScenario(entryFor("hb-scoped-wake-01"));
    const currentYear = new Date().getUTCFullYear();
    for (const item of artifact.timeline) {
      expect(item.at).toMatch(/^2026-08-0[89]T/);
      expect(item.at.startsWith(`${currentYear}-`) && item.at.includes(":")).toBe(
        item.at.startsWith("2026-"),
      );
    }
  });

  it("records the checkout as a control-plane action with no agent tool", async () => {
    const artifact = await capabilityRunScenario(entryFor("hb-scoped-wake-01"));
    const checkout = artifact.timeline.find(
      (item) => item.kind === "control_plane_action" && item.action === "run.opened",
    );
    expect(checkout).toBeDefined();
    expect(checkout && "summary" in checkout ? checkout.summary : "").toContain(
      "no agent tool exists for this",
    );
    expect(artifact.exposure.controlPlane.map((capability) => capability.operationId)).toContain(
      "checkout_task",
    );
    expect(
      artifact.exposure.always.map((tool) => tool.operationId).includes("checkout_task"),
    ).toBe(false);
  });

  it("shows optional tools with the grant that unlocked them", async () => {
    const artifact = await capabilityRunScenario(entryFor("rf-api-mgr-heartbeat-01"));
    expect(artifact.actor.role).toBe("manager");
    const listAgents = artifact.exposure.optional.find((tool) => tool.operationId === "list_agents");
    expect(listAgents?.unlockedBy).toBe("discovery:agents:read");
    expect(artifact.exposure.withheld.length).toBeGreaterThan(0);
  });

  it("renders a typed denial without exposing protected state", async () => {
    const artifact = await capabilityRunScenario(entryFor("ap-mcp-gate-01"));
    const denial = artifact.timeline.find(
      (item) => item.kind === "semantic_result" && (item.outcome === "denied" || item.outcome === "absent"),
    );
    expect(denial, "the gated approval scenario must record a denial").toBeDefined();
    if (denial?.kind === "semantic_result") {
      expect(denial.value).toBeNull();
      expect(denial.failure).not.toBeNull();
    }
    expect(
      artifact.authorizationRecords.some((record) => record.outcome !== "allowed"),
    ).toBe(true);
  });

  it("never lets a raw secret reach the run artifact", async () => {
    const artifact = await capabilityRunScenario(entryFor("rs-secret-hygiene-01"));
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("fixture-secret-value-not-a-real-credential");
    expect(serialized).toContain("[SECRET_VALUE]");
    const chip = artifact.timeline.find(
      (item) =>
        (item.kind === "semantic_call" || item.kind === "semantic_result") &&
        item.operationId === "read_secret_value",
    );
    expect(chip && "redactions" in chip ? chip.redactions.length : 0).toBeGreaterThan(0);
  });

  it("keeps restraint legible when the correct behaviour is absence", async () => {
    const artifact = await capabilityRunScenario(entryFor("rs-question-only-01"));
    const note = artifact.timeline.find((item) => item.kind === "system_note");
    expect(note).toBeDefined();
    expect(artifact.diff.domains.find((domain) => domain.domain === "documents")?.changed).toBe(false);
    expect(artifact.parity.forbidden.every((check) => !check.invoked)).toBe(true);
  });

  it("registers the deliverable before the task is finished", async () => {
    const artifact = await capabilityRunScenario(entryFor("ar-upload-before-done-01"));
    const order = artifact.timeline
      .filter((item) => item.kind === "semantic_call")
      .map((item) => (item.kind === "semantic_call" ? item.operationId : ""));
    expect(order.indexOf("register_deliverable")).toBeLessThan(order.indexOf("finish_task"));
    expect(artifact.diff.domains.find((domain) => domain.domain === "artifacts")?.changed).toBe(true);
  });

  it("routes a checkbox continuation, inspects its result, then acts on selectedOptionIds", async () => {
    const artifact = await capabilityRunScenario(entryFor("ix-checkbox-result-01"));
    const routeWake = artifact.timeline.find(
      (item) => item.kind === "control_plane_action" && item.action === "route_wake",
    );
    expect(routeWake).toMatchObject({
      kind: "control_plane_action",
      detail: {
        result: {
          selectedOptionIds: [
            "selected-task-1",
            "selected-task-2",
            "selected-task-3",
            "selected-task-4",
          ],
        },
      },
    });

    const calls = artifact.timeline.filter((item) => item.kind === "semantic_call");
    expect(calls.map((item) => item.operationId)).toEqual([
      "get_task_context",
      "inspect_operation_result",
      "create_task",
      "create_task",
      "create_task",
      "create_task",
    ]);
    const inspected = artifact.timeline.find(
      (item) => item.kind === "semantic_result" && item.operationId === "inspect_operation_result",
    );
    expect(inspected).toMatchObject({
      kind: "semantic_result",
      value: {
        wake: {
          payload: {
            result: {
              selectedOptionIds: [
                "selected-task-1",
                "selected-task-2",
                "selected-task-3",
                "selected-task-4",
              ],
            },
          },
        },
      },
    });
    expect(
      artifact.diff.domains
        .find((domain) => domain.domain === "tasks")
        ?.rows.filter((row) => row.change === "added"),
    ).toHaveLength(4);
  });

  it("shows first-class blocker edges in the state diff", async () => {
    const artifact = await capabilityRunScenario(entryFor("bl-create-blocked-01"));
    const blockers = artifact.diff.domains.find((domain) => domain.domain === "blockers");
    expect(blockers?.changed).toBe(true);
    expect(artifact.diff.domains.find((domain) => domain.domain === "tasks")?.changed).toBe(true);
  });

  it("carries the Capability verdict through without re-judging it", async () => {
    const entry = entryFor("mh-subtask-tree-01");
    const withoutReport = await capabilityRunScenario(entry);
    expect(withoutReport.parity.evalSuite.available).toBe(false);
    expect(withoutReport.parity.evalSuite.status).toBe("not_run");

    const lookup = capabilityEvalSuiteLookup({
      results: [
        {
          caseId: entry.id,
          semanticOperation: "create_task",
          authorizationDecision: "allowed",
          stateDiff: ["mock_state.revision"],
        },
      ],
    });
    const withReport = await capabilityRunScenario(entry, { evalSuite: lookup });
    expect(withReport.parity.evalSuite).toEqual({
      available: true,
      status: "pass",
      semanticOperation: "create_task",
      authorizationDecision: "allowed",
      stateDiff: ["mock_state.revision"],
    });
  });
});
