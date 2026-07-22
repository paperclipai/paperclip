import assert from "node:assert/strict";
import test from "node:test";
import { reviewDraft } from "./tools.js";

test("rejects ASCII umlaut substitutions and an incorrect Alan signature", () => {
  const result = reviewDraft(
    "Gruezi\n\nIch moechte Ihnen Tres Hermanos fuer Ihre Lounge vorstellen.\n\nFreundliche Gruesse\nAlan Frisco\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /normal German umlauts/);
  assert.match(result.violations.join("\n"), /Alan Christopherson/);
});

test("accepts normal Swiss German umlauts and the correct signature", () => {
  const result = reviewDraft(
    "Grüezi\n\nGerne stelle ich Ihnen Tres Hermanos für Ihre Lounge vor.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, true);
});

test("preserves the verified Cañonazo spelling", () => {
  const result = reviewDraft("Gerne zeige ich Ihnen den Canonazo.\n\nAlan Christopherson", "first_contact");
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /Cañonazo/);
});

test("rejects an unsupported weekday or travel commitment in first contact", () => {
  const result = reviewDraft(
    "Grüezi Frau Schild\n\nIch wäre am Dienstag oder Mittwoch in Lenzburg unterwegs und könnte vorbeikommen.\n\nFreundliche Grüsse\nAlan Christopherson",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /calendar evidence/);
});

test("allows a general meeting question without inventing a slot", () => {
  const result = reviewDraft(
    "Grüezi Frau Schild\n\nWäre ein kurzes Gespräch oder ein Besuch grundsätzlich interessant für Sie?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, true);
});
