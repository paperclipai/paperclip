import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseSlackFormPublicEnrollment } from "./cloud-forms.js";
import { slackFormEnrollmentActionId, slackFormEnrollmentCompatibleActionIds, isSlackFormEnrollmentActionId } from "./form-enrollment-identity.js";

const enrollment = parseSlackFormPublicEnrollment({ version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint",
  publicId: "p".repeat(43), connectionId: "connection", runtimeGeneration: 1, bindingId: "slack-event:" + "a".repeat(64), teamId: "TTEST", appId: "ATEST" });
const legacyId = (value: unknown) => `slack-form-owner:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
it("uses a complete typed tuple independent of input and JSONB object order", () => {
  const reversed = parseSlackFormPublicEnrollment(Object.fromEntries(Object.entries(enrollment).reverse()));
  const postgresOrder = parseSlackFormPublicEnrollment(Object.fromEntries(Object.entries(enrollment).sort(([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || a.localeCompare(b))));
  expect(slackFormEnrollmentActionId(reversed)).toBe(slackFormEnrollmentActionId(enrollment));
  expect(slackFormEnrollmentActionId(postgresOrder)).toBe(slackFormEnrollmentActionId(enrollment));
  expect(legacyId(reversed)).not.toBe(legacyId(enrollment));
});
it("recognizes only the exact known legacy producer orders for the same full authority tuple", () => {
  const e = enrollment;
  const connectionFirst = { version: e.version, instanceId: e.instanceId, companyId: e.companyId, endpointId: e.endpointId,
    connectionId: e.connectionId, publicId: e.publicId, runtimeGeneration: e.runtimeGeneration, teamId: e.teamId, appId: e.appId, bindingId: e.bindingId };
  const publicFirst = { version: e.version, instanceId: e.instanceId, companyId: e.companyId, endpointId: e.endpointId,
    publicId: e.publicId, connectionId: e.connectionId, runtimeGeneration: e.runtimeGeneration, teamId: e.teamId, appId: e.appId, bindingId: e.bindingId };
  for (const previous of [enrollment, connectionFirst, publicFirst])
    expect(isSlackFormEnrollmentActionId(legacyId(previous), parseSlackFormPublicEnrollment(Object.fromEntries(Object.entries(previous).reverse())))).toBe(true);
  expect(slackFormEnrollmentCompatibleActionIds(enrollment)).toHaveLength(4);
  expect(isSlackFormEnrollmentActionId(legacyId(Object.fromEntries(Object.entries(enrollment).reverse())), enrollment)).toBe(false);
  expect(isSlackFormEnrollmentActionId("slack-form-owner:" + "0".repeat(64), enrollment)).toBe(false);
});
it("every authority field is bound for canonical and compatible identities", () => {
  const variants = { instanceId: "other-instance", companyId: "other-company", endpointId: "other-endpoint", publicId: "q".repeat(43),
    connectionId: "other-connection", runtimeGeneration: 2, bindingId: "slack-event:" + "b".repeat(64), teamId: "TOTHER", appId: "AOTHER" };
  for (const [key, value] of Object.entries(variants)) {
    const changed = parseSlackFormPublicEnrollment({ ...enrollment, [key]: value });
    for (const id of slackFormEnrollmentCompatibleActionIds(enrollment)) expect(isSlackFormEnrollmentActionId(id, changed)).toBe(false);
  }
});
it("does not accept a different schema version or extra authority keys", () => {
  expect(() => parseSlackFormPublicEnrollment({ ...enrollment, version: 2 })).toThrow();
  expect(() => parseSlackFormPublicEnrollment({ ...enrollment, unexpected: "authority" })).toThrow();
});
