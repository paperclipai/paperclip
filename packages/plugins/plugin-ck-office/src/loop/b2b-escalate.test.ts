import assert from "node:assert/strict";
import test from "node:test";
import { isAutomaticReply } from "./b2b-escalate.js";

test("recognizes multilingual out-of-office messages as automatic replies", () => {
  assert.equal(isAutomaticReply("Réponse automatique : Votre message", "Je suis absent du lundi au dimanche."), true);
  assert.equal(isAutomaticReply("Automatic reply: Thank you", "I am currently out of the office."), true);
  assert.equal(isAutomaticReply("Automatische Antwort", "Ich bin nicht im Büro."), true);
});

test("does not suppress a genuine venue reply", () => {
  assert.equal(
    isAutomaticReply("Re: Tres Hermanos", "Merci pour votre message. Nous souhaitons organiser une dégustation."),
    false,
  );
});
