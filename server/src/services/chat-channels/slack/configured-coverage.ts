import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { createHash } from "node:crypto";
import type { ChatAdapterCapabilities } from "@paperclipai/shared";
import { parseSlackFormBinding, sameSlackFormBinding, type SlackFormBinding } from "./cloud-forms.js";
export const SLACK_INGRESS_LANES = ["actions", "commands", "events", "forms", "modal_close", "modal_submit", "options"] as const;
export type SlackIngressLane = typeof SLACK_INGRESS_LANES[number];
export type SlackConfiguredRequirement = Readonly<{ binding: SlackFormBinding; capabilities: Pick<ChatAdapterCapabilities, "actions" | "modals" | "slashCommands">; registeredOptions: boolean }>;
export type SlackConfiguredCoverage = Readonly<{ version: 1; instanceId: string; generation: string; bindingsFingerprint: string;
  entries: readonly Readonly<{ binding: SlackFormBinding; lanes: readonly SlackIngressLane[] }>[] }>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid Slack configured coverage");
  return Object.fromEntries(Object.entries(value));
}
export function requiredSlackIngressLanes(input: SlackConfiguredRequirement): readonly SlackIngressLane[] {
  const lanes: SlackIngressLane[] = ["events"];
  if (input.capabilities.actions) lanes.push("actions");
  if (input.capabilities.slashCommands) lanes.push("commands");
  if (input.capabilities.modals) lanes.push("forms", "modal_close", "modal_submit");
  if (input.registeredOptions) lanes.push("options");
  return lanes.sort();
}
export function slackConfiguredBindingsFingerprint(bindings: readonly SlackFormBinding[]): string {
  return hash(bindings.map(b => [b.instanceId, b.companyId, b.endpointId, b.publicId, b.connectionId, b.runtimeGeneration,
    b.teamId, b.appId, b.eventBindingId, b.credentialFingerprint]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
}
export function parseSlackConfiguredCoverage(value: unknown): SlackConfiguredCoverage {
  const v = exact(value, ["version", "instanceId", "generation", "bindingsFingerprint", "entries"]);
  if (v.version !== 1 || typeof v.instanceId !== "string" || !v.instanceId || typeof v.generation !== "string" || !/^[a-f0-9]{64}$/.test(v.generation)
    || typeof v.bindingsFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.bindingsFingerprint) || !Array.isArray(v.entries) || v.entries.length > 1000) throw new Error("Invalid Slack configured coverage");
  const seen = new Set<string>();
  const entries = v.entries.map(value => {
    const entry = exact(value, ["binding", "lanes"]), binding = parseSlackFormBinding(entry.binding);
    const key = JSON.stringify([binding.companyId, binding.endpointId, binding.connectionId]);
    if (binding.instanceId !== v.instanceId || seen.has(key) || !Array.isArray(entry.lanes) || !entry.lanes.length || new Set(entry.lanes).size !== entry.lanes.length
      || entry.lanes.join() !== [...entry.lanes].sort().join()) throw new Error("Invalid Slack configured coverage");
    seen.add(key);
    const lanes = entry.lanes.map(lane => {
      const known = SLACK_INGRESS_LANES.find(value => value === lane);
      if (!known) throw new Error("Unknown Slack configured lane");
      return known;
    });
    return Object.freeze({ binding: Object.freeze(binding), lanes: Object.freeze(lanes) });
  });
  if (slackConfiguredBindingsFingerprint(entries.map(entry => entry.binding)) !== v.bindingsFingerprint) throw new Error("Slack configured fingerprint changed");
  return Object.freeze({ version: 1, instanceId: v.instanceId, generation: v.generation, bindingsFingerprint: v.bindingsFingerprint, entries: Object.freeze(entries) });
}
export function matchSlackConfiguredCoverage(requirements: readonly SlackConfiguredRequirement[], verifiedCapabilities: VerifiedIdleCapabilities | undefined,
  expected: { instanceId: string; generation: string }): { endpointIds: readonly string[]; connectionIds: readonly string[] } | undefined {
  const incoming = verifiedCapabilities?.incomingWake;
  if (!incoming || !incoming.routes.some(route => String(route) === "slack-broker-events-v1")) return;
  const raw = Reflect.get(incoming, "slackBroker");
  if (raw === undefined) return;
  const verifiedProof = parseSlackConfiguredCoverage(raw);
  if (incoming.generation !== expected.generation || verifiedProof.instanceId !== expected.instanceId || verifiedProof.generation !== expected.generation || requirements.length > 1000) return;
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const binding = requirement.binding;
    if (binding.instanceId !== expected.instanceId || seen.has(binding.endpointId)) return;
    seen.add(binding.endpointId);
    const entry = verifiedProof.entries.find(value => sameSlackFormBinding(value.binding, binding));
    if (!entry || requiredSlackIngressLanes(requirement).some(lane => !entry.lanes.includes(lane))) return;
  }
  if (verifiedProof.bindingsFingerprint !== slackConfiguredBindingsFingerprint(requirements.map(value => value.binding))) return;
  return { endpointIds: [...seen].sort(), connectionIds: [...new Set(requirements.map(value => value.binding.connectionId))].sort() };
}
