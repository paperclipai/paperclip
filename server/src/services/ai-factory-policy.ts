import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  factoryPolicyV1Schema,
  type CompiledFactoryPolicyV1,
  type FactoryPolicyServerInvariantsV1,
  type FactoryPolicyStageV1,
  type FactoryPolicyV1,
  type IssueExecutionPolicy,
  type IssueExecutionStage,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

export const PAPERCLIP_AI_FACTORY_BASE_SKILL_KEY = "paperclipai/paperclip/paperclip-ai-factory" as const;
export const AI_FACTORY_POLICY_SKILL_SLUG = "ai-factory-policy" as const;
export const AI_FACTORY_POLICY_FILE = "factory-policy.yaml" as const;
export const AI_FACTORY_POLICY_SETTING_KEY = "aiFactoryPolicySkillKey" as const;

export const DEFAULT_FACTORY_POLICY_V1: FactoryPolicyV1 = {
  version: 1,
  extends: PAPERCLIP_AI_FACTORY_BASE_SKILL_KEY,
  topology: {
    defaultExecutionLanes: 1,
    maxExecutionLanes: 10,
    allowParallelLanes: false,
    noGrandchildren: true,
  },
  roles: {
    controlOwnerRole: "ceo",
    laneCoordinatorRole: "cto",
  },
  stages: [
    { key: "contract", type: "work", role: "cto" },
    { key: "implementation", type: "work", role: "engineer" },
    { key: "independent_qa", type: "verification", role: "qa", independent: true },
    { key: "technical_acceptance", type: "review", role: "cto" },
    { key: "deployment", type: "deployment", role: "devops", optionalWhen: "production" },
    { key: "live_qa", type: "verification", role: "qa", independent: true, optionalWhen: "production" },
    { key: "final_acceptance", type: "approval", role: "cto", optionalWhen: "production" },
  ],
  productionAuthority: {
    mode: "autonomous_unless_hold",
    requireCapabilityPreflightBeforeEscalation: true,
    requireBoardApprovalForIrreversibleActions: true,
  },
  recovery: {
    attemptMinutes: [2, 10, 30],
    maxAttemptsPerEvidenceFingerprint: 3,
  },
};

export const FACTORY_POLICY_SERVER_INVARIANTS_V1: FactoryPolicyServerInvariantsV1 = {
  appendOnlyEvidence: true,
  generatedProseIsAdvisory: true,
  explicitHoldsStopMutation: true,
  noGrandchildren: true,
  recoveryDeduplicatedByEvidenceFingerprint: true,
};

export const FACTORY_POLICY_PRECEDENCE = [
  "server_invariants",
  "issue_contract",
  "company_policy",
  "agent_skills",
] as const;

export const FACTORY_POLICY_MANAGED_ROUTE_ERROR_CODE = "factory_managed_route_required" as const;
export const FACTORY_SNAPSHOT_INCONSISTENT_ERROR_CODE = "factory_snapshot_inconsistent" as const;

export function factoryPolicyStageIsSelected(stage: FactoryPolicyStageV1, production: boolean) {
  if (stage.optionalWhen === "production") return production;
  if (stage.optionalWhen === "non_production") return !production;
  return true;
}

export function factoryStageReturnTarget(stages: FactoryPolicyStageV1[], index: number) {
  const stage = stages[index]!;
  if (stage.type !== "verification" && stage.type !== "review" && stage.type !== "approval") return null;
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = stages[candidateIndex]!;
    if (candidate.type === "work" || candidate.type === "deployment") return candidate.key;
  }
  return null;
}

export function factoryStageEvidenceGates(stage: FactoryPolicyStageV1) {
  const byStageKey: Record<string, string[]> = {
    implementation: [
      "delivery:implementation:succeeded",
      "delivery:ci:succeeded:provider_verified",
    ],
    independent_qa: ["delivery:functional_qa:succeeded"],
    technical_acceptance: [
      "delivery:functional_qa:succeeded",
      "delivery:technical_acceptance:accepted:paperclip_verified",
    ],
    deployment: ["delivery:deployment:succeeded:provider_verified"],
    live_qa: [
      "delivery:deployment:succeeded:provider_verified",
      "delivery:smoke:succeeded",
    ],
    final_acceptance: [
      "delivery:deployment:succeeded:provider_verified",
      "delivery:smoke:succeeded",
      "delivery:business_acceptance:accepted:paperclip_verified",
    ],
  };
  return byStageKey[stage.key] ?? [];
}

export function effectiveFactoryExecutionLaneMaximum(policy: FactoryPolicyV1) {
  return policy.topology.allowParallelLanes ? policy.topology.maxExecutionLanes : 1;
}

function executionPolicyWithoutMonitor(policy: IssueExecutionPolicy | null) {
  if (!policy) return null;
  const { monitor: _monitor, ...withoutMonitor } = policy;
  return withoutMonitor;
}

/**
 * Generic issue mutation endpoints may carry an unchanged factory policy only
 * so callers can schedule or clear its monitor. Factory topology, stages, and
 * immutable policy metadata are owned by the typed execution-lane endpoint.
 */
export function assertFactoryPolicyManagedRouteMutation(input: {
  previous: IssueExecutionPolicy | null;
  next: IssueExecutionPolicy | null;
  managedRoute?: string;
}) {
  const previousFactory = input.previous?.factory ?? null;
  const nextFactory = input.next?.factory ?? null;
  if (!previousFactory && !nextFactory) return;
  if (
    previousFactory
    && nextFactory
    && isDeepStrictEqual(
      executionPolicyWithoutMonitor(input.previous),
      executionPolicyWithoutMonitor(input.next),
    )
  ) {
    return;
  }

  const reason = !previousFactory && nextFactory
    ? "factory_snapshot_attach"
    : previousFactory && !nextFactory
      ? "factory_snapshot_remove"
      : "factory_managed_fields_changed";
  throw unprocessable(
    "AI Factory execution policies are server-managed. Use the typed execution-lane route.",
    {
      code: FACTORY_POLICY_MANAGED_ROUTE_ERROR_CODE,
      reason,
      managedRoute: input.managedRoute ?? "POST /api/issues/:controlIssueId/execution-lanes",
    },
  );
}

function snapshotConflict(
  rule: string,
  message: string,
  factory: NonNullable<IssueExecutionPolicy["factory"]>,
  details: Record<string, unknown> = {},
): never {
  throw conflict(message, {
    code: FACTORY_SNAPSHOT_INCONSISTENT_ERROR_CODE,
    rule,
    laneKind: factory.laneKind,
    policyKey: factory.policyKey,
    policyVersion: factory.policyVersion,
    policyHash: factory.policyHash,
    ...details,
  });
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stageAgentIds(stage: IssueExecutionStage) {
  return stage.participants.flatMap((participant) =>
    participant.type === "agent" && participant.agentId ? [participant.agentId] : []);
}

/**
 * Verifies that persisted factory metadata and its executable stage projection
 * are a faithful, immutable projection of the snapshotted company policy.
 */
export function assertFactoryExecutionPolicySnapshotConsistent(input: {
  executionPolicy: IssueExecutionPolicy;
  fallbackPolicySnapshot?: FactoryPolicyV1;
  expectedControlIssueId?: string | null;
}) {
  const factory = input.executionPolicy.factory;
  if (!factory) {
    throw conflict("The issue does not contain an AI Factory policy snapshot.", {
      code: FACTORY_SNAPSHOT_INCONSISTENT_ERROR_CODE,
      rule: "factory_metadata_missing",
    });
  }
  const snapshot = factory.policySnapshot ?? input.fallbackPolicySnapshot;
  if (!snapshot) {
    snapshotConflict(
      "policy_snapshot_missing",
      "The AI Factory policy snapshot is missing.",
      factory,
    );
  }

  const computedHash = factoryPolicyContentHash(snapshot);
  if (factory.policyHash !== computedHash) {
    snapshotConflict(
      "policy_hash",
      "The AI Factory policy hash does not match its immutable snapshot.",
      factory,
      { computedPolicyHash: computedHash },
    );
  }
  if (factory.policyVersion !== String(snapshot.version)) {
    snapshotConflict(
      "policy_version",
      "The AI Factory policy version does not match its immutable snapshot.",
      factory,
      { snapshotVersion: String(snapshot.version) },
    );
  }

  const maximum = effectiveFactoryExecutionLaneMaximum(snapshot);
  const expectedTopologyMode = factory.laneKind === "control"
    ? maximum === 1 ? "single_execution_lane" : "direct_execution_lanes"
    : "same_issue_only";
  if (factory.topologyMode !== expectedTopologyMode || factory.maxExecutionLanes !== maximum) {
    snapshotConflict(
      "topology",
      "The AI Factory topology does not match its immutable snapshot.",
      factory,
      {
        expectedTopologyMode,
        expectedMaxExecutionLanes: maximum,
        actualTopologyMode: factory.topologyMode,
        actualMaxExecutionLanes: factory.maxExecutionLanes,
      },
    );
  }

  if (factory.laneKind === "control") {
    if (factory.controlIssueId) {
      snapshotConflict(
        "control_issue",
        "An AI Factory control policy cannot reference another control issue.",
        factory,
        { controlIssueId: factory.controlIssueId },
      );
    }
    if (input.expectedControlIssueId !== undefined && input.expectedControlIssueId !== null) {
      snapshotConflict(
        "lane_kind",
        "An AI Factory execution-lane policy was expected.",
        factory,
        { expectedControlIssueId: input.expectedControlIssueId },
      );
    }
    return snapshot;
  }

  const expectedControlIssueId = input.expectedControlIssueId;
  if (
    !factory.controlIssueId
    || (expectedControlIssueId !== undefined && factory.controlIssueId !== expectedControlIssueId)
  ) {
    snapshotConflict(
      "control_issue",
      "The AI Factory execution lane does not reference its expected control issue.",
      factory,
      {
        expectedControlIssueId: expectedControlIssueId ?? null,
        actualControlIssueId: factory.controlIssueId ?? null,
      },
    );
  }

  const production = factory.production ?? false;
  const projectedStages = snapshot.stages.filter((stage) => factoryPolicyStageIsSelected(stage, production));
  if (input.executionPolicy.stages.length !== projectedStages.length) {
    snapshotConflict(
      "stage_projection",
      "The AI Factory execution stages do not match the immutable policy snapshot.",
      factory,
      {
        expectedStageKeys: projectedStages.map((stage) => stage.key),
        actualStageKeys: input.executionPolicy.stages.map((stage) => stage.key ?? null),
      },
    );
  }

  const priorWorkAndDeploymentAgentIds = new Set<string>();
  for (const [index, projected] of projectedStages.entries()) {
    const actual = input.executionPolicy.stages[index]!;
    if (
      actual.key !== projected.key
      || actual.type !== projected.type
      || actual.role !== projected.role
      || Boolean(actual.independent) !== Boolean(projected.independent)
    ) {
      snapshotConflict(
        "stage_projection",
        "An AI Factory execution stage does not match the immutable policy snapshot.",
        factory,
        {
          stageIndex: index,
          expectedStage: {
            key: projected.key,
            type: projected.type,
            role: projected.role,
            independent: Boolean(projected.independent),
          },
          actualStage: {
            key: actual.key ?? null,
            type: actual.type,
            role: actual.role ?? null,
            independent: Boolean(actual.independent),
          },
        },
      );
    }

    const expectedReturnTarget = factoryStageReturnTarget(projectedStages, index);
    if ((actual.returnToStageKey ?? null) !== expectedReturnTarget) {
      snapshotConflict(
        "return_target",
        "An AI Factory stage return target does not match the immutable policy snapshot.",
        factory,
        {
          stageKey: projected.key,
          expectedReturnToStageKey: expectedReturnTarget,
          actualReturnToStageKey: actual.returnToStageKey ?? null,
        },
      );
    }

    const expectedEvidenceGates = factoryStageEvidenceGates(projected);
    const actualEvidenceGates = actual.evidenceGates ?? [];
    if (!sameStringList(actualEvidenceGates, expectedEvidenceGates)) {
      snapshotConflict(
        "evidence_gates",
        "An AI Factory stage evidence gate does not match the immutable policy snapshot.",
        factory,
        {
          stageKey: projected.key,
          expectedEvidenceGates,
          actualEvidenceGates,
        },
      );
    }

    if (
      actual.participants.length !== 1
      || actual.participants[0]?.type !== "agent"
      || !actual.participants[0].agentId
    ) {
      snapshotConflict(
        "stage_participant",
        "An AI Factory stage must have exactly one server-selected agent participant.",
        factory,
        {
          stageKey: projected.key,
          participantCount: actual.participants.length,
          participantTypes: actual.participants.map((participant) => participant.type),
        },
      );
    }

    const actualAgentIds = stageAgentIds(actual);
    if (
      projected.independent
      && actualAgentIds.some((agentId) => priorWorkAndDeploymentAgentIds.has(agentId))
    ) {
      snapshotConflict(
        "stage_independence",
        "An independent AI Factory stage reuses a prior work or deployment participant.",
        factory,
        {
          stageKey: projected.key,
          conflictingAgentIds: actualAgentIds
            .filter((agentId) => priorWorkAndDeploymentAgentIds.has(agentId))
            .sort(),
        },
      );
    }
    if (projected.type === "work" || projected.type === "deployment") {
      for (const agentId of actualAgentIds) priorWorkAndDeploymentAgentIds.add(agentId);
    }
  }

  return snapshot;
}

type YamlLine = { indent: number; content: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || trimmed.startsWith("[")
    || trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function prepareYamlLines(raw: string): YamlLine[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function parseYamlBlock(
  lines: YamlLine[],
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  if (lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-")) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const separator = remainder.indexOf(":");
      if (separator > 0 && !remainder.startsWith("[") && !remainder.startsWith("{")) {
        const entry: Record<string, unknown> = {
          [remainder.slice(0, separator).trim()]: parseYamlScalar(remainder.slice(separator + 1)),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isRecord(nested.value)) Object.assign(entry, nested.value);
          index = nested.nextIndex;
        }
        values.push(entry);
      } else {
        values.push(parseYamlScalar(remainder));
      }
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separator = line.content.indexOf(":");
    if (separator <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separator).trim();
    const remainder = line.content.slice(separator + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
    } else {
      record[key] = parseYamlScalar(remainder);
    }
  }
  return { value: record, nextIndex: index };
}

export function parseFactoryPolicyDocument(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw unprocessable("AI Factory policy cannot be empty.");
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw unprocessable("AI Factory policy is not valid JSON/YAML.", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const lines = prepareYamlLines(content);
  const parsed = lines.length > 0 ? parseYamlBlock(lines, 0, lines[0]!.indent).value : {};
  if (!isRecord(parsed)) throw unprocessable("AI Factory policy must be a YAML object.");
  return parsed;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function factoryPolicyContentHash(policy: FactoryPolicyV1): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(policy)))
    .digest("hex");
}

export function compileFactoryPolicyV1(
  input: unknown,
  skillKey: string,
): CompiledFactoryPolicyV1 {
  const candidate = typeof input === "string" ? parseFactoryPolicyDocument(input) : input;
  const parsed = factoryPolicyV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw unprocessable("AI Factory policy is invalid.", {
      skillKey,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const policy = parsed.data as FactoryPolicyV1;
  return {
    version: 1,
    skillKey,
    contentHash: factoryPolicyContentHash(policy),
    policy,
    serverInvariants: FACTORY_POLICY_SERVER_INVARIANTS_V1,
    precedence: FACTORY_POLICY_PRECEDENCE,
  };
}

function quoteYamlString(value: string) {
  return /^[a-z0-9_/-]+$/i.test(value) ? value : JSON.stringify(value);
}

export function serializeFactoryPolicyV1(policy: FactoryPolicyV1): string {
  const lines = [
    `version: ${policy.version}`,
    `extends: ${policy.extends}`,
    "topology:",
    `  defaultExecutionLanes: ${policy.topology.defaultExecutionLanes}`,
    `  maxExecutionLanes: ${policy.topology.maxExecutionLanes}`,
    `  allowParallelLanes: ${policy.topology.allowParallelLanes}`,
    `  noGrandchildren: ${policy.topology.noGrandchildren}`,
    "roles:",
    `  controlOwnerRole: ${quoteYamlString(policy.roles.controlOwnerRole)}`,
    `  laneCoordinatorRole: ${quoteYamlString(policy.roles.laneCoordinatorRole)}`,
    "stages:",
  ];
  for (const stage of policy.stages) {
    lines.push(
      `  - key: ${quoteYamlString(stage.key)}`,
      `    type: ${stage.type}`,
      `    role: ${quoteYamlString(stage.role)}`,
    );
    if (stage.independent !== undefined) lines.push(`    independent: ${stage.independent}`);
    if (stage.optionalWhen !== undefined) lines.push(`    optionalWhen: ${stage.optionalWhen}`);
  }
  lines.push(
    "productionAuthority:",
    `  mode: ${policy.productionAuthority.mode}`,
    `  requireCapabilityPreflightBeforeEscalation: ${policy.productionAuthority.requireCapabilityPreflightBeforeEscalation}`,
    `  requireBoardApprovalForIrreversibleActions: ${policy.productionAuthority.requireBoardApprovalForIrreversibleActions}`,
    "recovery:",
    `  attemptMinutes: [${policy.recovery.attemptMinutes.join(", ")}]`,
    `  maxAttemptsPerEvidenceFingerprint: ${policy.recovery.maxAttemptsPerEvidenceFingerprint}`,
    "",
  );
  return lines.join("\n");
}

export function defaultCompanyAiFactoryPolicySkillKey(companyId: string): string {
  return `company/${companyId}/${AI_FACTORY_POLICY_SKILL_SLUG}`;
}

export function readCompanyAiFactoryPolicySkillKey(
  settings: Record<string, unknown> | null | undefined,
  companyId: string,
): string {
  const selected = settings?.[AI_FACTORY_POLICY_SETTING_KEY];
  return typeof selected === "string" && selected.trim().length > 0
    ? selected.trim()
    : defaultCompanyAiFactoryPolicySkillKey(companyId);
}

export function withCompanyAiFactoryPolicySkillKey(
  settings: Record<string, unknown> | null | undefined,
  skillKey: string,
): Record<string, unknown> {
  return { ...(settings ?? {}), [AI_FACTORY_POLICY_SETTING_KEY]: skillKey };
}
