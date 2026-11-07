import { createHash } from "node:crypto";
import { parseSlackFormPublicEnrollment, type SlackFormPublicEnrollment } from "./cloud-forms.js";

function actionId(value: readonly unknown[] | SlackFormPublicEnrollment): string {
  return `slack-form-owner:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
export function slackFormEnrollmentActionId(input: SlackFormPublicEnrollment): string {
  const e = parseSlackFormPublicEnrollment(input);
  return actionId(["slack-form-owner/v2", e.version, e.instanceId, e.companyId, e.endpointId, e.publicId,
    e.connectionId, e.runtimeGeneration, e.bindingId, e.teamId, e.appId]);
}
export function slackFormEnrollmentCompatibleActionIds(input: SlackFormPublicEnrollment): readonly string[] {
  const e = parseSlackFormPublicEnrollment(input);
  const projected: SlackFormPublicEnrollment = { version: e.version, instanceId: e.instanceId, companyId: e.companyId,
    endpointId: e.endpointId, publicId: e.publicId, connectionId: e.connectionId, runtimeGeneration: e.runtimeGeneration,
    bindingId: e.bindingId, teamId: e.teamId, appId: e.appId };
  const bindingDerived: SlackFormPublicEnrollment = { version: e.version, instanceId: e.instanceId, companyId: e.companyId,
    endpointId: e.endpointId, connectionId: e.connectionId, publicId: e.publicId, runtimeGeneration: e.runtimeGeneration,
    teamId: e.teamId, appId: e.appId, bindingId: e.bindingId };
  const publicFirstBinding: SlackFormPublicEnrollment = { version: e.version, instanceId: e.instanceId, companyId: e.companyId,
    endpointId: e.endpointId, publicId: e.publicId, connectionId: e.connectionId, runtimeGeneration: e.runtimeGeneration,
    teamId: e.teamId, appId: e.appId, bindingId: e.bindingId };
  return [slackFormEnrollmentActionId(e), actionId(projected), actionId(bindingDerived), actionId(publicFirstBinding)];
}
export function isSlackFormEnrollmentActionId(providerActionId: unknown, enrollment: SlackFormPublicEnrollment): boolean {
  return typeof providerActionId === "string" && slackFormEnrollmentCompatibleActionIds(enrollment).includes(providerActionId);
}
