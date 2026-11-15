import { expect, it } from "vitest";
import { parseSlackFormBinding } from "./cloud-forms.js";
import { slackFormAttentionCanRearm } from "./form-owner.js";
const binding = parseSlackFormBinding({ version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", publicId: "p".repeat(43), connectionId: "connection",
  runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
const { eventBindingId, credentialFingerprint, ...identity } = binding;
const enrollment = { ...identity, bindingId: eventBindingId };
it("allows a recoverable cipher failure only under the exact current configured authority", () => {
  expect(slackFormAttentionCanRearm({ code: "form_opening_cipher_unavailable", binding, enrollment })).toBe(true);
});
it("refuses foreign company and replaced instance during explicit configuration rearm", () => {
  expect(slackFormAttentionCanRearm({ code: "form_opening_cipher_unavailable", binding: { ...binding, companyId: "foreign" }, enrollment })).toBe(false);
  expect(slackFormAttentionCanRearm({ code: "form_opening_cipher_unavailable", binding: { ...binding, instanceId: "foreign" }, enrollment })).toBe(false);
});
it("does not rewrite stale generations or known authority conflicts into retryable work", () => {
  expect(slackFormAttentionCanRearm({ code: "form_opening_cipher_unavailable", binding: { ...binding, runtimeGeneration: 2 }, enrollment })).toBe(false);
  expect(slackFormAttentionCanRearm({ code: "form_owner_authority_unavailable", binding, enrollment })).toBe(false);
});
it("unknown malformed attention stays blocked without aborting other eligible retries", () => {
  expect(slackFormAttentionCanRearm({ code: "form_opening_cipher_unavailable", binding: { malformed: true }, enrollment })).toBe(false);
});
