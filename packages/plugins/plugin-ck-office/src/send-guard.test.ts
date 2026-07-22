import assert from "node:assert/strict";
import test from "node:test";
import { resolveEspoSendRoute, setEspoSendLiveEnabled } from "./send-guard.js";

test("instance setting enables an accepted venue message to route live", () => {
  setEspoSendLiveEnabled(true);
  const result = resolveEspoSendRoute({
    to: "venue@example.ch",
    subject: "A genuine follow-up",
    body: "Thank you for your reply.",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverTo, "venue@example.ch");
    assert.equal(result.liveSend, true);
    assert.equal(result.testLock, false);
  }
  setEspoSendLiveEnabled(null);
});

test("test wording stays blocked from venue delivery even when live is enabled", () => {
  setEspoSendLiveEnabled(true);
  const result = resolveEspoSendRoute({
    to: "venue@example.ch",
    subject: "Kurzer Test",
    body: "Bitte ignorieren.",
  });
  assert.equal(result.ok, false);
  setEspoSendLiveEnabled(null);
});
