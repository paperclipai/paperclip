import type { CapabilityCatalogReconciliation } from "./reconciliation.js";

export interface OperationGroupsCanonicalOperation {
  operationId: string;
  surfaces: readonly string[];
  placement: "always_agent_tool" | "optional_agent_tool";
  requiredClaims: readonly string[];
  taskModes: readonly string[];
  allowedRoles?: readonly string[];
  sideEffectClass: string;
  idempotency: string;
  redacts: boolean;
  mockCommandMapping: null | {
    kind: string;
    projection?: string;
    commandKind?: string;
    extension?: string;
  };
  realBindingStatus: string;
  realServiceBinding: string;
  prpEvidence: string;
  prpBindingStatus: string;
}

export interface OperationGroupsSource {
  schemaVersion: number;
  documentTitle: string;
  evalRepositoryUrl: string;
  prpEventFamilyDescriptions: Record<string, string>;
  prpCommandFamilyDescriptions: Record<string, string>;
  optionalGrantGroups: Array<{
    id: string;
    description: string;
    operationIds: string[];
  }>;
  behaviorGroups: BehaviorGroupSource[];
  rules: Record<"companyAuthorization" | "taskModes" | "redaction" | "idempotency" | "sideEffects", string[]>;
  documentLifecycle: {
    scope: string[];
    operations: Array<{
      action: string;
      semanticOperation: string;
      placement: string;
      contract: string;
      status: string;
    }>;
  };
  legacySemanticTargetDispositions: Record<string, {
    kind: "control_plane" | "folded" | "composite" | "known_gap";
    targets: string[];
    reason: string;
  }>;
}

export interface BehaviorGroupSource {
  id: string;
  legacyGroup: number;
  name: string;
  owner: string;
  operationIds: string[];
  controlPlaneOperationIds: string[];
  realSurface: string;
  mockStateDomains: string[];
  prpEvidence: string;
  gap: string;
}

export interface OperationGroupsScenario {
  id: string;
  title: string;
  group: string;
  legacyGroup: number;
  sourceAnchor: string;
  expectedSemantics?: string[];
  requiredGrants?: string[];
  evidenceIds?: string[];
}

export interface LegacyAliasRow {
  id: string;
  name: string;
  foldedInto: string;
  sourceAnchor: string;
}

export interface OperationGroupsInput {
  source: OperationGroupsSource;
  canonicalOperations: readonly OperationGroupsCanonicalOperation[];
  reconciliation: CapabilityCatalogReconciliation;
  controlPlaneOperationIds: readonly string[];
  liveCatalogOperationIds: readonly string[];
  generatedContractOperationIds: readonly string[];
  scenarios: readonly OperationGroupsScenario[];
  eventTypes: readonly string[];
  commandTypes: readonly string[];
  legacyAliases: readonly LegacyAliasRow[];
  sourceContractToolMappings: Readonly<Record<string, readonly [string, string]>>;
  rootIndexSource: string;
  catalogIndexSource: string;
}

const EXPECTED_EVENT_COUNT = 105;
const EXPECTED_COMMAND_COUNT = 18;
const EXPECTED_SCENARIO_COUNT = 106;
const EXPECTED_BEHAVIOR_GROUP_COUNT = 16;

export function validateOperationGroupsInput(input: OperationGroupsInput): void {
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
  };

  if (input.source.schemaVersion !== 1) fail(`Unsupported operation-groups source schema ${input.source.schemaVersion}.`);
  if (input.eventTypes.length !== EXPECTED_EVENT_COUNT) {
    fail(`PRP event catalog has ${input.eventTypes.length} events; expected ${EXPECTED_EVENT_COUNT}.`);
  }
  if (input.commandTypes.length !== EXPECTED_COMMAND_COUNT) {
    fail(`PRP command catalog has ${input.commandTypes.length} commands; expected ${EXPECTED_COMMAND_COUNT}.`);
  }
  if (input.scenarios.length !== EXPECTED_SCENARIO_COUNT) {
    fail(`Behavior catalog has ${input.scenarios.length} scenarios; expected ${EXPECTED_SCENARIO_COUNT}.`);
  }
  if (input.source.behaviorGroups.length !== EXPECTED_BEHAVIOR_GROUP_COUNT) {
    fail(`Operation-groups source has ${input.source.behaviorGroups.length} behavior groups; expected ${EXPECTED_BEHAVIOR_GROUP_COUNT}.`);
  }

  compareSets(
    "PRP event-family descriptions",
    Object.keys(input.source.prpEventFamilyDescriptions),
    families(input.eventTypes),
    fail,
  );
  compareSets(
    "PRP command-family descriptions",
    Object.keys(input.source.prpCommandFamilyDescriptions),
    families(input.commandTypes),
    fail,
  );

  const canonicalIds = input.canonicalOperations.map((operation) => operation.operationId);
  const alwaysIds = input.canonicalOperations
    .filter((operation) => operation.placement === "always_agent_tool")
    .map((operation) => operation.operationId);
  const optionalIds = input.canonicalOperations
    .filter((operation) => operation.placement === "optional_agent_tool")
    .map((operation) => operation.operationId);
  const groupedOptionalIds = input.source.optionalGrantGroups.flatMap((group) => group.operationIds);
  compareSets("optional grant-group operations", groupedOptionalIds, optionalIds, fail);
  reportDuplicates("optional grant-group operations", groupedOptionalIds, fail);

  const behaviorOperationIds = input.source.behaviorGroups.flatMap((group) => group.operationIds);
  compareSets("behavior coverage semantic operations", behaviorOperationIds, canonicalIds, fail);
  const behaviorControlPlaneIds = input.source.behaviorGroups.flatMap(
    (group) => group.controlPlaneOperationIds,
  );
  compareSets(
    "behavior coverage control-plane operations",
    behaviorControlPlaneIds,
    input.controlPlaneOperationIds,
    fail,
  );

  const scenariosByGroup = groupBy(input.scenarios, (scenario) => scenario.group);
  compareSets(
    "behavior group ids",
    input.source.behaviorGroups.map((group) => group.id),
    [...scenariosByGroup.keys()],
    fail,
  );
  for (const group of input.source.behaviorGroups) {
    const rows = scenariosByGroup.get(group.id) ?? [];
    const legacyGroups = new Set(rows.map((row) => row.legacyGroup));
    if (legacyGroups.size !== 1 || !legacyGroups.has(group.legacyGroup)) {
      fail(`Behavior group ${group.id} legacyGroup disagrees with scenario authority.`);
    }
  }
  reportDuplicates("scenario ids", input.scenarios.map((scenario) => scenario.id), fail);

  compareSets(
    "generated semantic contract",
    input.generatedContractOperationIds,
    input.liveCatalogOperationIds,
    fail,
  );
  const liveCanonicalIds = input.canonicalOperations
    .filter((operation) => operation.surfaces.includes("live"))
    .map((operation) => operation.operationId);
  compareSets("canonical live surface", input.liveCatalogOperationIds, liveCanonicalIds, fail);

  const sourceContractNames = Object.keys(input.sourceContractToolMappings);
  compareSets(
    "legacy alias inventory/source contract",
    input.legacyAliases.map((alias) => alias.name),
    sourceContractNames,
    fail,
  );
  const scenarioIds = new Set(input.scenarios.map((scenario) => scenario.id));
  const canonicalById = new Map(input.canonicalOperations.map((operation) => [operation.operationId, operation]));
  const controlPlaneIds = new Set(input.controlPlaneOperationIds);
  const nonCanonicalSourceTargets = new Set<string>();
  for (const alias of input.legacyAliases) {
    const evalId = alias.foldedInto.replace(/^eval:/, "");
    if (!scenarioIds.has(evalId)) fail(`Legacy alias ${alias.name} folds into missing scenario ${alias.foldedInto}.`);
    const mapping = input.sourceContractToolMappings[alias.name];
    if (mapping === undefined) continue;
    const [placement, semanticTarget] = mapping;
    const canonical = canonicalById.get(semanticTarget);
    if (canonical !== undefined) {
      if (canonical.placement !== placement) {
        fail(`Source-contract placement for ${alias.name} is ${placement}; canonical ${semanticTarget} is ${canonical.placement}.`);
      }
      continue;
    }
    nonCanonicalSourceTargets.add(semanticTarget);
    const disposition = input.source.legacySemanticTargetDispositions[semanticTarget];
    if (disposition === undefined) {
      fail(`Source-contract semantic target ${semanticTarget} has no canonical operation or reconciliation disposition.`);
      continue;
    }
    for (const target of disposition.targets) {
      if (!canonicalById.has(target) && !controlPlaneIds.has(target)) {
        fail(`Legacy target ${semanticTarget} points at unknown reconciliation target ${target}.`);
      }
    }
  }
  compareSets(
    "legacy source-target dispositions",
    Object.keys(input.source.legacySemanticTargetDispositions),
    [...nonCanonicalSourceTargets],
    fail,
  );

  // Keep the expected source text split so the tracked-import scanner does not
  // mistake this assertion string for an import owned by this module.
  const expectedRootCatalogExport = `export * from ${JSON.stringify([".", "/catalog", "/index.js"].join(""))};`;
  if (!input.rootIndexSource.includes(expectedRootCatalogExport)) {
    fail("Package root does not export the canonical catalog barrel.");
  }
  if (!/export \* from ["']\.\/reconciliation\.js["'];/.test(input.catalogIndexSource)) {
    fail("Catalog barrel does not export the canonical reconciliation authority.");
  }

  if (input.reconciliation.unionCount !== canonicalIds.length) {
    fail("Catalog reconciliation union count disagrees with canonical operations.");
  }
  if (input.reconciliation.alwaysCount !== alwaysIds.length) {
    fail("Catalog reconciliation always count disagrees with canonical operations.");
  }
  if (input.reconciliation.optionalCount !== optionalIds.length) {
    fail("Catalog reconciliation optional count disagrees with canonical operations.");
  }

  if (failures.length > 0) {
    throw new Error(`Operation-groups drift detected:\n- ${failures.join("\n- ")}`);
  }
}

export function renderOperationGroupsDocument(input: OperationGroupsInput): string {
  validateOperationGroupsInput(input);
  const {
    source,
    canonicalOperations,
    reconciliation,
    controlPlaneOperationIds,
    scenarios,
    eventTypes,
    commandTypes,
    legacyAliases,
    sourceContractToolMappings,
  } = input;
  const lines: string[] = [];
  const always = canonicalOperations.filter((operation) => operation.placement === "always_agent_tool");
  const optional = canonicalOperations.filter((operation) => operation.placement === "optional_agent_tool");
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));

  lines.push(
    "<!-- GENERATED FILE — DO NOT EDIT. Run `pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts`. -->",
    "",
    `# ${source.documentTitle}`,
    "",
    "Status: canonical explanatory contract for the Paperclip runner V1 surface.",
    "",
    "This document keeps three independent meanings of **group** separate. PRP families describe wire evidence and controller commands; capability placement decides who owns an operation; behavioral eval groups organize the 106 scenario corpus. None of the three axes can be used as a substitute for another.",
    "",
    `The generated totals are **${eventTypes.length} PRP events in ${families(eventTypes).length} event families**, **${commandTypes.length} controller commands in ${families(commandTypes).length} command families**, **${controlPlaneOperationIds.length} control-plane operations**, **${canonicalOperations.length} reconciled semantic operations** (${always.length} always, ${optional.length} optional), and **${scenarios.length} scenarios in ${source.behaviorGroups.length} behavior groups**.`,
    "",
    "## Axis 1: PRP v1 event and command families",
    "",
    "PRP records ordered, replayable execution evidence. It is not the model's Paperclip tool API. Events are ordered per `sourceInstanceId`; duplicate `sourceEventId` values are idempotent; source-sequence gaps remain evidence; replay is side-effect free; unknown required versions fail closed.",
    "",
    "### Event families",
    "",
    "| Family | Purpose | Events | Count |",
    "| --- | --- | --- | ---: |",
  );
  for (const [family, members] of groupedFamilies(eventTypes)) {
    lines.push(row([
      code(family),
      source.prpEventFamilyDescriptions[family] ?? "",
      members.map(code).join("<br>"),
      String(members.length),
    ]));
  }
  lines.push(
    "",
    "### Controller-command families",
    "",
    "| Family | Purpose | Commands | Count |",
    "| --- | --- | --- | ---: |",
  );
  for (const [family, members] of groupedFamilies(commandTypes)) {
    lines.push(row([
      code(family),
      source.prpCommandFamilyDescriptions[family] ?? "",
      members.map(code).join("<br>"),
      String(members.length),
    ]));
  }

  lines.push(
    "",
    "## Axis 2: capability placement",
    "",
    "Placement has exactly three outcomes:",
    "",
    "- `control_plane_owned`: Paperclip or the runner performs the operation; it is absent from the model tool catalog.",
    "- `always_agent_tool`: every eligible active-task run receives the operation after task-mode and actor checks.",
    "- `optional_agent_tool`: the operation is exposed only when every declared claim, task-mode, role, and policy condition passes.",
    "",
    "### Control-plane-owned operations",
    "",
    "| Operation | Why it is not a model tool |",
    "| --- | --- |",
  );
  const controlPlaneReasons: Record<string, string> = {
    checkout_task: "Atomic checkout and execution-lock ownership.",
    release_task: "Run cleanup and checkout release.",
    select_work: "Scoped wake/inbox work selection.",
    route_wake: "Attention, blocker, interaction, approval, and continuation routing.",
    enforce_budget: "Budget hard stop, pause, and run-stop reason.",
    append_audit_record: "Immutable mutation evidence.",
    persist_run: "Durable run/event/checkpoint persistence.",
    replay_run: "Side-effect-free replay and reconstruction.",
    schedule_blocker_wake: "Dependency-resolution wake scheduling.",
    reconcile_run: "Work assessment, terminal status arbitration, and recovery reconciliation.",
  };
  for (const operationId of controlPlaneOperationIds) {
    lines.push(row([code(operationId), controlPlaneReasons[operationId] ?? "Control-plane invariant."]));
  }

  lines.push(
    "",
    `### Always-agent operations (${always.length})`,
    "",
    always.map((operation) => code(operation.operationId)).join(", ") + ".",
    "",
    `### Optional operations (${optional.length}) and grant groups (${source.optionalGrantGroups.length})`,
    "",
    "Grant groups are documentation/exposure bundles, not additional authority. The operation descriptor's exact `requiredClaims` remains decisive.",
    "",
    "| Grant group | Operations | Required claims represented | Purpose |",
    "| --- | --- | --- | --- |",
  );
  const operationById = new Map(canonicalOperations.map((operation) => [operation.operationId, operation]));
  for (const group of source.optionalGrantGroups) {
    const claims = unique(group.operationIds.flatMap((id) => operationById.get(id)?.requiredClaims ?? []));
    lines.push(row([
      code(group.id),
      group.operationIds.map(code).join("<br>"),
      claims.length === 0 ? "none" : claims.map(code).join("<br>"),
      group.description,
    ]));
  }

  lines.push(
    "",
    "### Reconciled semantic-operation ledger",
    "",
    "`live_codex` means a live provider dispatcher exists. Production binding is tracked separately: `bound` rows are advertised by Paperclip's run-scoped authority over the shared PRP route, while `audit_pending` rows remain unavailable to production agents. `generic_api_request` is test-only and cannot satisfy product coverage.",
    "",
    "| Operation | Placement | Claims | Modes / roles | Side effect | Idempotency | Redacts | Mock | Catalogs / current runner | Production / PRP evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const operation of canonicalOperations) {
    lines.push(row([
      code(operation.operationId),
      code(operation.placement),
      listOrNone(operation.requiredClaims),
      `${listOrNone(operation.taskModes)}${operation.allowedRoles === undefined ? "" : `<br>roles: ${listOrNone(operation.allowedRoles)}`}`,
      code(operation.sideEffectClass),
      code(operation.idempotency),
      operation.redacts ? "yes" : "no",
      operation.mockCommandMapping === null ? "inline/no mapping" : code(mockMappingLabel(operation.mockCommandMapping)),
      `${operation.surfaces.map(code).join(" + ")}<br>${code(operation.realBindingStatus)}`,
      `${code(operation.realServiceBinding)}<br>${operation.prpEvidence}<br>catalog PRP status: ${code(operation.prpBindingStatus)}`,
    ]));
  }

  lines.push(
    "",
    "## Axis 3: the 16 behavioral eval groups",
    "",
    "Behavior groups describe expected outcomes and trajectories. They do not grant tools and they do not define PRP event types. The matrix is generated from the behavior-group source plus the checked-in eval traceability manifest; scenario counts and membership cannot be hand-edited here.",
    "",
    "### Coverage matrix",
    "",
    "| Group | Owner | Semantic operations | Control-plane operations | Real Paperclip surface | Mock state | Scenarios | PRP evidence | Gap / disposition |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
  );
  const scenariosByGroup = groupBy(scenarios, (scenario) => scenario.group);
  for (const group of source.behaviorGroups) {
    lines.push(row([
      `[\`${group.id}\` — ${group.name}](#behavior-group-${group.id}-${slug(group.name)})`,
      group.owner,
      group.operationIds.length === 0 ? "none" : group.operationIds.map(code).join("<br>"),
      group.controlPlaneOperationIds.length === 0 ? "none" : group.controlPlaneOperationIds.map(code).join("<br>"),
      group.realSurface,
      group.mockStateDomains.map(code).join("<br>"),
      String((scenariosByGroup.get(group.id) ?? []).length),
      group.prpEvidence,
      group.gap,
    ]));
  }

  lines.push("", "### Scenario links");
  for (const group of source.behaviorGroups) {
    const members = [...(scenariosByGroup.get(group.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    lines.push(
      "",
      `#### Behavior group ${group.id}: ${group.name}`,
      "",
      `${members.length} scenarios (legacy group ${group.legacyGroup}):`,
      "",
    );
    for (const scenario of members) {
      lines.push(`- [\`${scenario.id}\`](${scenarioUrl(source, scenario)}) — ${scenario.title}`);
    }
  }

  lines.push("", "## Authorization and execution invariants");
  pushRuleSection(lines, "Company and actor authorization", source.rules.companyAuthorization);
  pushRuleSection(lines, "Task modes and exposure", source.rules.taskModes);
  pushRuleSection(lines, "Redaction", source.rules.redaction);
  pushRuleSection(lines, "Idempotency and replay", source.rules.idempotency);
  pushRuleSection(lines, "Side effects and terminal ownership", source.rules.sideEffects);

  lines.push("", "## Issue-document lifecycle", "");
  for (const paragraph of source.documentLifecycle.scope) lines.push(paragraph, "");
  lines.push(
    "| Action | Semantic operation | Placement | Contract | Status |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const operation of source.documentLifecycle.operations) {
    lines.push(row([
      code(operation.action),
      code(operation.semanticOperation),
      code(operation.placement),
      operation.contract,
      operation.status,
    ]));
  }
  lines.push(
    "",
    "All document writes produce a normalized receipt. Success includes the document key/id, prior and new revision identity, idempotency key, and audit reference. Missing/stale bases return `base_revision_required` or `stale_base_revision` with the current revision. Authorization, cross-company, and lock failures use stable redacted denial codes. The runner never overwrites after a conflict without a fresh read and explicit reconciled write.",
    "",
    "## Provenance, generation, and drift gates",
    "",
    "The machine-readable authority for this document's decisions is `spec/operation-groups/source.json`. The generator joins that source to these independently versioned authorities and rejects disagreement:",
    "",
    "- the package-exported `CAPABILITY_CANONICAL_CATALOG` in `src/catalog/` — the 41-operation authority, including enriched mock/redaction and divergence facts.",
    "- `src/tools/capability-semantic-tool-types.ts` — 10 control-plane-owned operation IDs.",
    "- `protocol/schemas/event.schema.json` and `command.schema.json` — PRP event/command members and families.",
    "- `spec/capability/eval-traceability.yaml` — all 16 groups and 106 scenario identities/source anchors.",
    "- `spec/capability/source-contract.json` and `mcp-tool-map.yaml` — legacy MCP placement and fold authority.",
    "- `generated/capability/semantic-tool-contracts.json` — generated provider contract; it must equal the live catalog exactly.",
    "- `src/catalog/index.ts` and `src/index.ts` — package export path for the canonical reconciliation authority.",
    "",
    "Regenerate and check reproducibly:",
    "",
    "```sh",
    "pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts",
    "pnpm --filter @paperclipai/paperclip-runner exec tsx scripts/generate-operation-groups.ts --check",
    "pnpm --filter @paperclipai/paperclip-runner exec vitest run src/catalog/operation-groups-doc.test.ts src/catalog/reconciliation.test.ts src/catalog/catalog-docs.test.ts",
    "```",
    "",
    "The `--check` path fails on catalog membership, optional-group coverage, control-plane coverage, PRP schema families/counts, behavior/scenario membership, legacy alias folds, source-contract targets, generated live contracts, package exports, or byte-level Markdown drift. Generation is offline and uses only checked-in inputs.",
    "",
    "Current responsibility-based paths are normative. Numbered `phase-*` or milestone paths are historical and must not be reintroduced.",
    "",
    "## Reconciliation appendix",
    "",
    "### Catalog split and deliberate replacement",
    "",
    `- Scenario/eval catalog: **${reconciliation.scenarioCount}** operations.`,
    `- Live dispatcher catalog: **${reconciliation.liveCount}** operations.`,
    `- Shared: **${reconciliation.sharedCount}**; union/canonical authority: **${reconciliation.unionCount}**.`,
    `- Scenario-only: ${reconciliation.scenarioOnly.map(code).join(", ")}.`,
    `- Live-only: ${reconciliation.liveOnly.map(code).join(", ")}.`,
    "- The generated provider contract contains exactly the live catalog; the canonical union remains the migration authority until all scenario-only operations are either implemented, deferred, or removed by an explicit reconciliation decision.",
    "- `generic_api_request` stays exported only for controlled tests and cannot be cited as real-surface, mock-parity, or PRP product coverage.",
    "",
    "### Legacy MCP aliases",
    "",
    "The MCP inventory is a compatibility index, not a third product catalog. Every alias folds into an eval scenario and its source-contract semantic target must resolve to a canonical operation, a control-plane operation, an approved composite/fold, or a named gap.",
    "",
    "| MCP alias | Source placement / target | Reconciled target | Eval evidence |",
    "| --- | --- | --- | --- |",
  );
  for (const alias of legacyAliases) {
    const mapping = sourceContractToolMappings[alias.name];
    const semanticTarget = mapping?.[1] ?? "missing";
    const disposition = source.legacySemanticTargetDispositions[semanticTarget];
    const reconciled = disposition === undefined
      ? code(semanticTarget)
      : `${code(disposition.kind)} → ${disposition.targets.length === 0 ? "named gap" : disposition.targets.map(code).join(", ")}<br>${disposition.reason}`;
    const scenarioId = alias.foldedInto.replace(/^eval:/, "");
    const scenario = scenarioById.get(scenarioId);
    const evidence = scenario === undefined
      ? code(alias.foldedInto)
      : `[\`${scenario.id}\`](${scenarioUrl(source, scenario)})`;
    lines.push(row([
      code(alias.name),
      `${mapping === undefined ? "missing" : code(mapping[0])} / ${code(semanticTarget)}`,
      reconciled,
      evidence,
    ]));
  }

  lines.push(
    "",
    "### PRP expressiveness boundary",
    "",
    "PRP v1 already represents runner/session/turn/item lifecycle, replay identity, capability negotiation, request/interaction routing, result negotiation, attention, work assessment, issue-status decision, and terminal causality. Provider-neutral semantic-operation receipts (including authorization/redaction/idempotency/conflict facts) and explicit budget-stop reasons are additive v1 work. Destructive administration, cross-company actions, board-only governance, document lock/unlock/delete, checkout selection, audit persistence, and final arbitration remain control-plane-local and do not become model tools or generic PRP commands.",
    "",
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function pushRuleSection(lines: string[], title: string, rules: readonly string[]): void {
  lines.push("", `### ${title}`, "");
  for (const rule of rules) lines.push(`- ${rule}`);
}

function compareSets(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
  fail: (message: string) => void,
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value)).sort();
  const extra = [...actualSet].filter((value) => !expectedSet.has(value)).sort();
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} disagree (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
  }
}

function reportDuplicates(label: string, values: readonly string[], fail: (message: string) => void): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) fail(`${label} contain duplicates: ${[...duplicates].sort().join(", ")}.`);
}

function family(value: string): string {
  return value.slice(0, value.indexOf("."));
}

function families(values: readonly string[]): string[] {
  return unique(values.map(family));
}

function groupedFamilies(values: readonly string[]): Array<[string, string[]]> {
  return [...groupBy(values, family).entries()];
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const bucket = grouped.get(id) ?? [];
    bucket.push(value);
    grouped.set(id, bucket);
  }
  return grouped;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function code(value: string): string {
  return `\`${value}\``;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(code).join("<br>");
}

function mockMappingLabel(mapping: NonNullable<OperationGroupsCanonicalOperation["mockCommandMapping"]>): string {
  if ("projection" in mapping) return `${mapping.kind}:${mapping.projection}`;
  if ("commandKind" in mapping) return `${mapping.kind}:${mapping.commandKind}`;
  if ("extension" in mapping) return `${mapping.kind}:${mapping.extension}`;
  return mapping.kind;
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function scenarioUrl(source: OperationGroupsSource, scenario: OperationGroupsScenario): string {
  const relative = scenario.sourceAnchor.replace(/^paperclip-evals\//, "");
  return `${source.evalRepositoryUrl}${relative}`;
}
