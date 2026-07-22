import assert from "node:assert/strict";
import test from "node:test";
import { mergeEmailAddressData, verifyInboundEmailEvidence } from "./tools.js";

test("adds an inbound-verified address without replacing the existing primary", () => {
  const merged = mergeEmailAddressData(
    "bar@venue.ch",
    [{ emailAddress: "bar@venue.ch", primary: true, optOut: false, invalid: false }],
    "person@venue.ch",
  );
  assert.equal(merged.emailAddress, "bar@venue.ch");
  assert.equal(merged.alreadyPresent, false);
  assert.deepEqual(
    merged.emailAddressData.map((row) => [row.emailAddress, row.primary]),
    [["bar@venue.ch", true], ["person@venue.ch", false]],
  );
});

test("CRM inbound evidence must match sender and Account", () => {
  const evidence = {
    fromAddress: "person@venue.ch",
    parentType: "Account",
    parentId: "account-1",
    status: "Archived",
  };
  assert.deepEqual(verifyInboundEmailEvidence(evidence, "account-1", "person@venue.ch"), { ok: true });
  assert.equal(verifyInboundEmailEvidence(evidence, "account-2", "person@venue.ch").ok, false);
  assert.equal(verifyInboundEmailEvidence(evidence, "account-1", "other@venue.ch").ok, false);
  assert.equal(verifyInboundEmailEvidence({ ...evidence, status: "Sent" }, "account-1", "person@venue.ch").ok, false);
});
