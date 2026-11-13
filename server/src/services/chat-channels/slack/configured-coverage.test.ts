import { expect, it } from "vitest";
import { CAPABILITIES } from "../provider-catalog.js";
import { parseSlackFormBinding } from "./cloud-forms.js";
import { requiredSlackIngressLanes, parseSlackConfiguredCoverage, slackConfiguredBindingsFingerprint, matchSlackConfiguredCoverage } from "./configured-coverage.js";
const binding = parseSlackFormBinding({ version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", publicId: "p".repeat(43), connectionId: "connection",
  runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
const requirement = { binding, capabilities: CAPABILITIES.slack, registeredOptions: false };
it("requires every default configured Slack lane rather than treating a form slice as complete", () => {
  expect(requiredSlackIngressLanes(requirement)).toEqual(["actions", "commands", "events", "forms", "modal_close", "modal_submit"]);
});
it("requires options whenever a real options handler is registered", () => {
  expect(requiredSlackIngressLanes({ ...requirement, registeredOptions: true })).toContain("options");
});
it("the closed coverage parser refuses foreign instance and altered exact binding fingerprint", () => {
  const proof = { version: 1, instanceId: "instance", generation: "c".repeat(64), bindingsFingerprint: slackConfiguredBindingsFingerprint([binding]),
    entries: [{ binding, lanes: requiredSlackIngressLanes(requirement) }] };
  expect(parseSlackConfiguredCoverage(proof).entries[0]?.binding.connectionId).toBe("connection");
  expect(() => parseSlackConfiguredCoverage({ ...proof, instanceId: "foreign" })).toThrow();
  expect(() => parseSlackConfiguredCoverage({ ...proof, bindingsFingerprint: "d".repeat(64) })).toThrow();
});
it("absence of a genuinely verified capability never discharges endpoint or connection IDs", () => {
  expect(matchSlackConfiguredCoverage([requirement], undefined, { instanceId: "instance", generation: "c".repeat(64) })).toBeUndefined();
});
