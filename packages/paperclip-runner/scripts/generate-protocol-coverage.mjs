#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PAPERCLIP_PROTOCOL_ACTIONS } from "../dist/protocol-actions/index.js";
import { buildCapabilityScenarioIndex } from "../dist/scenarios/scenario-index.js";
import { capabilityScenarioFixture } from "../dist/scenarios/scenario-fixtures.js";
import { capabilityScenarioPlan } from "../dist/scenarios/scenario-plan.js";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "spec/capability/eval-traceability.yaml");
const outputPath = resolve(root, "spec/capability/protocol-coverage.json");
const index = buildCapabilityScenarioIndex(await readFile(manifestPath, "utf8"));
const catalog = PAPERCLIP_PROTOCOL_ACTIONS.map((action) => ({
  id: action.id,
  ownership: action.canonical.placement,
  surfaces: action.canonical.surfaces,
  legacyAliases: action.canonical.legacyAliases,
}));

const requirements = index.entries.map((entry) => {
  const plan = capabilityScenarioPlan(entry, capabilityScenarioFixture(entry));
  const operations = new Set(plan.controlPlaneCapabilities.map((item) => item.operationId));
  for (const step of plan.steps) if (step.kind === "tool_call") operations.add(step.operationId);
  return {
    id: entry.id,
    title: entry.title,
    fixture: entry.fixture,
    operations: [...operations].sort(),
    sourceAnchor: entry.sourceAnchor,
    assertionClasses: entry.assertionClasses,
    deterministicOwner: "src/scenarios/scenario-explorer.test.ts::renders every scenario with exposure, control plane, authorization, diff, and parity",
  };
});

const lifecycleRequirements = [
  ["provider-round-trip", "provider -> runnerd -> control plane -> runnerd -> provider", "src/live/runnerd-codex-transport.test.ts"],
  ["single-daemon", "one Paperclip-owned sandbox daemon and no TypeScript sandbox dispatcher", "src/live/runnerd-codex-transport.test.ts"],
  ["catalog-drift", "canonical catalog consistency and drift rejection", "runner/crates/runner-core/src/provider_bridge.rs::durable_session_refuses_catalog_drift"],
  ["authorization", "authorization denial and unknown-tool rejection", "runner/crates/runner-core/src/provider_bridge.rs::forwards_only_authorized_calls_and_correlates_results"],
  ["duplicates", "correlated duplicate and conflicting-result handling", "runner/crates/runner-core/src/provider_bridge.rs::rejects_unknown_tools_and_conflicting_duplicate_results"],
  ["recovery", "lost ACK, reconnect, runner restart, and provider-thread recovery", "src/control-plane/durable-prp-control-plane.test.ts; src/live/live-session.test.ts"],
  ["interrupt", "interruption while waiting for a tool result", "src/live/live-session.test.ts; src/live/clean-room-server.test.ts"],
  ["bounds", "bounded queues, logs, frames, and retries", "src/live/turn-stream.test.ts; runner/crates/runner-core/src/durable/runner.rs"],
  ["cleanup", "process-group cleanup with no abandoned provider", "runner/crates/runner-core/tests/process_supervisor.rs"],
  ["secrets", "secret isolation and network restrictions", "src/live/clean-room-server.test.ts; runner/crates/runner-core/src/durable/runner.rs"],
  ["transcript-accounting", "assistant transcript capture, token usage, and cost inputs", "src/live/live-session.test.ts; src/cli/eval-session.ts"],
  ["state-reconstruction", "fixture and post-run state reconstruction", "src/scenarios/scenario-explorer.test.ts; src/live/live-session.test.ts"],
  ["paperclip-adapter-selection", "paperclip_runner is selectable without changing legacy adapter behavior", "server/src/services/native-runtime/runtime-mode.test.ts; server/src/__tests__/heartbeat-native-runner-selection.test.ts"],
  ["real-control-plane-binding", "advertised runner tools re-authorize the live company, issue, agent, and run before using real Paperclip services", "server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts; server/src/services/native-runtime/paperclip-runner-real-server.integration.test.ts"],
  ["shared-paperclip-prp-route", "Rust runnerd authenticates to the shared Paperclip server route and completes a real bound semantic tool call", "server/src/realtime/runner-prp-ws.test.ts; server/src/services/native-runtime/paperclip-runner-real-server.integration.test.ts"],
  ["real-control-plane-idempotency", "real service mutations are replay-safe and reject conflicting idempotency-key reuse", "server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts"],
  ["paperclip-thread-projection", "committed PRP reasoning and semantic tool items render in the existing Paperclip task chat", "ui/src/adapters/paperclip-runner/index.test.ts; server/src/services/native-runtime/paperclip-control-plane-port.test.ts"],
];

const actions = catalog.map((action) => ({
  ...action,
  contractCase: `protocol-action:${action.id}`,
  contractOwner: `src/catalog/protocol-action-contracts.test.ts::${action.id} has a schema-valid canonical example and every declared projection`,
  legacyBehavioralCases: requirements.filter((row) => row.operations.includes(action.id)).map((row) => row.id),
  deterministicCases: [
    `protocol-action:${action.id}`,
    ...requirements.filter((row) => row.operations.includes(action.id)).map((row) => row.id),
  ],
  legacyRequirementCases: index.entries
    .filter((entry) => action.legacyAliases.some((alias) => entry.legacyMcpAliases.includes(alias)))
    .map((entry) => entry.id),
  deterministicOwners: [
    `src/catalog/protocol-action-contracts.test.ts::${action.id} has a schema-valid canonical example and every declared projection`,
    "src/scenarios/scenario-explorer.test.ts::renders every scenario with exposure, control plane, authorization, diff, and parity",
  ],
}));

const document = {
  schema: "paperclip-runner/protocol-coverage/v1",
  generatedFrom: [
    "spec/capability/eval-traceability.yaml",
    "src/tools/capability-semantic-tool-catalog.ts",
    "src/tools/capability-semantic-tool-types.ts",
    "src/scenarios/scenario-plan.ts",
  ],
  counts: { actions: actions.length, legacyRequirements: requirements.length },
  actions,
  discoveryGateways: [
    { id: "discover_capabilities", deterministicOwners: ["src/semantic-tools/semantic-tools.test.ts::discovers only authorized optional tools and returns trusted schemas"] },
    { id: "invoke_discovered_capability", deterministicOwners: ["src/control-plane/durable-prp-control-plane.test.ts; src/live/live-session.test.ts"] },
  ],
  legacyRequirements: requirements,
  lifecycleRequirements: lifecycleRequirements.map(([id, requirement, deterministicOwner]) => ({ id, requirement, deterministicOwner })),
};
const encoded = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== encoded) throw new Error("protocol coverage artifact is stale; run pnpm generate:protocol-coverage");
} else {
  await writeFile(outputPath, encoded);
  process.stdout.write(`Wrote ${outputPath}\n`);
}
