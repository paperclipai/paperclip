import assert from "node:assert/strict";
import { test } from "vitest";
import {
  namedSalutation,
  verifySalutationIdentity,
  verifyVenueRecipient,
} from "./tools.js";

test("named greeting is rejected when only a general account mailbox is known", async () => {
  const espo = {
    get: async () => ({ name: "ART CIGAR", emailAddress: "lenzburg@artcibar.ch" }),
    related: async () => ({ list: [{ name: "Susi Schild", emailAddress: "susi@artcibar.ch" }] }),
  };
  const recipient = await verifyVenueRecipient(espo, "account-1", "lenzburg@artcibar.ch");
  assert.equal(recipient.ok, true);
  if (!recipient.ok) return;
  assert.deepEqual(recipient.contactNames, []);
  assert.deepEqual(
    verifySalutationIdentity("Grüezi Frau Schild\n\nWir möchten ...", recipient),
    {
      ok: false,
      error:
        "Named salutation 'Schild' is not evidence-backed for lenzburg@artcibar.ch. " +
        "No CRM Contact owns this exact address; use a neutral greeting such as 'Sehr geehrte Damen und Herren' or 'Guten Tag'.",
    },
  );
});

test("named greeting is allowed only when that contact owns the exact address", async () => {
  const espo = {
    get: async () => ({ name: "Venue", emailAddress: "info@venue.ch" }),
    related: async () => ({
      list: [{ firstName: "Susi", lastName: "Schild", emailAddress: "susi@venue.ch" }],
    }),
  };
  const recipient = await verifyVenueRecipient(espo, "account-1", "susi@venue.ch");
  assert.equal(recipient.ok, true);
  if (!recipient.ok) return;
  assert.deepEqual(verifySalutationIdentity("Sehr geehrte Frau Schild\n\nGuten Tag.", recipient), { ok: true });
  assert.equal(verifySalutationIdentity("Grüezi Herr Meier\n\nGuten Tag.", recipient).ok, false);
});

test("neutral greetings are never interpreted as named recipients", () => {
  assert.equal(namedSalutation("Sehr geehrte Damen und Herren\n\nGuten Tag."), null);
  assert.equal(namedSalutation("Guten Tag\n\nGuten Tag."), null);
  assert.equal(namedSalutation("Grüezi zusammen\n\nGuten Tag."), null);
});
