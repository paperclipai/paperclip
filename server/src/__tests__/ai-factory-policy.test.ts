import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import {
  DEFAULT_FACTORY_POLICY_V1,
  PAPERCLIP_AI_FACTORY_BASE_SKILL_KEY,
  assertFactoryExecutionPolicySnapshotConsistent,
  assertFactoryPolicyManagedRouteMutation,
  compileFactoryPolicyV1,
  factoryPolicyContentHash,
  serializeFactoryPolicyV1,
} from "../services/ai-factory-policy.js";

const CTO_ID = "11111111-1111-4111-8111-111111111111";
const ENGINEER_ID = "22222222-2222-4222-8222-222222222222";
const QA_ID = "33333333-3333-4333-8333-333333333333";
const CONTROL_ID = "44444444-4444-4444-8444-444444444444";

function executionPolicyFixture(): IssueExecutionPolicy {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        key: "contract",
        type: "work",
        role: "cto",
        independent: false,
        returnToStageKey: null,
        evidenceGates: [],
        approvalsNeeded: 1,
        participants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", type: "agent", agentId: CTO_ID }],
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        key: "implementation",
        type: "work",
        role: "engineer",
        independent: false,
        returnToStageKey: null,
        evidenceGates: [
          "delivery:implementation:succeeded",
          "delivery:ci:succeeded:provider_verified",
        ],
        approvalsNeeded: 1,
        participants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", type: "agent", agentId: ENGINEER_ID }],
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        key: "independent_qa",
        type: "verification",
        role: "qa",
        independent: true,
        returnToStageKey: "implementation",
        evidenceGates: ["delivery:functional_qa:succeeded"],
        approvalsNeeded: 1,
        participants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", type: "agent", agentId: QA_ID }],
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        key: "technical_acceptance",
        type: "review",
        role: "cto",
        independent: false,
        returnToStageKey: "implementation",
        evidenceGates: [
          "delivery:functional_qa:succeeded",
          "delivery:technical_acceptance:accepted:paperclip_verified",
        ],
        approvalsNeeded: 1,
        participants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", type: "agent", agentId: CTO_ID }],
      },
    ],
    factory: {
      schemaVersion: 1,
      laneKind: "execution",
      topologyMode: "same_issue_only",
      controlIssueId: CONTROL_ID,
      coordinator: { type: "agent", agentId: CTO_ID },
      policyKey: "company/acme/ai-factory-policy",
      policyVersion: "1",
      policyHash: factoryPolicyContentHash(DEFAULT_FACTORY_POLICY_V1),
      maxExecutionLanes: 1,
      policySnapshot: structuredClone(DEFAULT_FACTORY_POLICY_V1),
      production: false,
    },
  };
}

function expectFactoryRule(run: () => unknown, rule: string) {
  try {
    run();
    throw new Error("Expected factory consistency validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).details).toMatchObject({
      code: "factory_snapshot_inconsistent",
      rule,
    });
  }
}

describe("AI Factory policy compiler", () => {
  it("round-trips the default YAML into a stable compiled policy", () => {
    const yaml = serializeFactoryPolicyV1(DEFAULT_FACTORY_POLICY_V1);
    const first = compileFactoryPolicyV1(yaml, "company/acme/ai-factory-policy");
    const second = compileFactoryPolicyV1(
      JSON.parse(JSON.stringify(DEFAULT_FACTORY_POLICY_V1)),
      "company/acme/ai-factory-policy",
    );

    expect(first.policy).toEqual(DEFAULT_FACTORY_POLICY_V1);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.precedence).toEqual([
      "server_invariants",
      "issue_contract",
      "company_policy",
      "agent_skills",
    ]);
    expect(first.serverInvariants).toMatchObject({
      generatedProseIsAdvisory: true,
      noGrandchildren: true,
    });
  });

  it("keeps the bundled reference policy synchronized with the server default", async () => {
    const bundled = await fs.readFile(
      new URL("../../../skills/paperclip-ai-factory/references/factory-policy.yaml", import.meta.url),
      "utf8",
    );
    expect(compileFactoryPolicyV1(bundled, PAPERCLIP_AI_FACTORY_BASE_SKILL_KEY).policy)
      .toEqual(DEFAULT_FACTORY_POLICY_V1);
  });

  it("rejects attempts to disable no-grandchildren enforcement", () => {
    expect(() => compileFactoryPolicyV1({
      ...DEFAULT_FACTORY_POLICY_V1,
      topology: {
        ...DEFAULT_FACTORY_POLICY_V1.topology,
        noGrandchildren: false,
      },
    }, "company/acme/unsafe")).toThrowError(/AI Factory policy is invalid/);
  });

  it("rejects duplicate lifecycle stages and unbounded retry schedules", () => {
    expect(() => compileFactoryPolicyV1({
      ...DEFAULT_FACTORY_POLICY_V1,
      extends: PAPERCLIP_AI_FACTORY_BASE_SKILL_KEY,
      stages: [
        ...DEFAULT_FACTORY_POLICY_V1.stages,
        { key: "implementation", type: "work", role: "engineer" },
      ],
      recovery: {
        attemptMinutes: [2, 10, 30],
        maxAttemptsPerEvidenceFingerprint: 4,
      },
    }, "company/acme/invalid")).toThrowError(/AI Factory policy is invalid/);
  });

  it.each([
    ["missing independent QA", (policy: typeof DEFAULT_FACTORY_POLICY_V1) => {
      policy.stages = policy.stages.filter((stage) => stage.key !== "independent_qa");
    }],
    ["wrong QA independence", (policy: typeof DEFAULT_FACTORY_POLICY_V1) => {
      policy.stages.find((stage) => stage.key === "independent_qa")!.independent = false;
    }],
    ["deployment before technical acceptance", (policy: typeof DEFAULT_FACTORY_POLICY_V1) => {
      const deploymentIndex = policy.stages.findIndex((stage) => stage.key === "deployment");
      const [deployment] = policy.stages.splice(deploymentIndex, 1);
      policy.stages.splice(2, 0, deployment!);
    }],
    ["production stage without production condition", (policy: typeof DEFAULT_FACTORY_POLICY_V1) => {
      delete policy.stages.find((stage) => stage.key === "deployment")!.optionalWhen;
    }],
    ["unsupported default lane fanout", (policy: typeof DEFAULT_FACTORY_POLICY_V1) => {
      policy.topology.allowParallelLanes = true;
      policy.topology.defaultExecutionLanes = 2;
    }],
  ])("rejects an impossible policy projection: %s", (_label, mutate) => {
    const policy = structuredClone(DEFAULT_FACTORY_POLICY_V1);
    mutate(policy);
    expect(() => compileFactoryPolicyV1(policy, "company/acme/impossible"))
      .toThrowError(/AI Factory policy is invalid/);
  });

  it("accepts a faithful executable projection of a frozen policy snapshot", () => {
    const executionPolicy = executionPolicyFixture();
    expect(assertFactoryExecutionPolicySnapshotConsistent({
      executionPolicy,
      expectedControlIssueId: CONTROL_ID,
    })).toEqual(DEFAULT_FACTORY_POLICY_V1);
  });

  it.each([
    ["policy_hash", (policy: IssueExecutionPolicy) => { policy.factory!.policyHash = "deadbeef"; }],
    ["policy_version", (policy: IssueExecutionPolicy) => { policy.factory!.policyVersion = "2"; }],
    ["topology", (policy: IssueExecutionPolicy) => { policy.factory!.maxExecutionLanes = 2; }],
    ["stage_projection", (policy: IssueExecutionPolicy) => { policy.stages[0]!.role = "engineer"; }],
    ["return_target", (policy: IssueExecutionPolicy) => { policy.stages[2]!.returnToStageKey = "contract"; }],
    ["evidence_gates", (policy: IssueExecutionPolicy) => { policy.stages[1]!.evidenceGates = []; }],
    ["stage_participant", (policy: IssueExecutionPolicy) => {
      policy.stages[1]!.participants.push({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
        type: "agent",
        agentId: QA_ID,
      });
    }],
    ["stage_independence", (policy: IssueExecutionPolicy) => {
      policy.stages[2]!.participants[0]!.agentId = ENGINEER_ID;
    }],
  ])("rejects a frozen snapshot inconsistency in %s", (rule, mutate) => {
    const executionPolicy = structuredClone(executionPolicyFixture());
    mutate(executionPolicy);
    expectFactoryRule(() => assertFactoryExecutionPolicySnapshotConsistent({
      executionPolicy,
      expectedControlIssueId: CONTROL_ID,
    }), rule);
  });

  it("reserves first attachment and managed-field changes for the typed factory route", () => {
    const executionPolicy = executionPolicyFixture();
    try {
      assertFactoryPolicyManagedRouteMutation({ previous: null, next: executionPolicy });
      throw new Error("Expected first attachment to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).details).toMatchObject({
        code: "factory_managed_route_required",
        reason: "factory_snapshot_attach",
      });
    }

    const changed = structuredClone(executionPolicy);
    changed.stages[0]!.role = "engineer";
    try {
      assertFactoryPolicyManagedRouteMutation({ previous: executionPolicy, next: changed });
      throw new Error("Expected managed-field mutation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).details).toMatchObject({
        code: "factory_managed_route_required",
        reason: "factory_managed_fields_changed",
      });
    }
  });

  it("allows a monitor-only update while preserving every factory-managed field", () => {
    const previous = executionPolicyFixture();
    const next = structuredClone(previous);
    next.monitor = {
      nextCheckAt: "2026-07-20T12:00:00.000Z",
      notes: "Wait for the provider observation.",
      scheduledBy: "board",
    };
    expect(() => assertFactoryPolicyManagedRouteMutation({ previous, next })).not.toThrow();
  });
});
