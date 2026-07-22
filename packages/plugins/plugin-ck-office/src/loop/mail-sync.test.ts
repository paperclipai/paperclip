import assert from "node:assert/strict";
import test from "node:test";
import { isAfterMailSyncCursor, isKnownSystemSend } from "./mail-sync.js";

test("only durable send-ledger ids are classified as Paperclip system sends", () => {
  const ledger = new Set(["espo-system-1"]);
  assert.equal(isKnownSystemSend("espo-system-1", ledger), true);
  assert.equal(isKnownSystemSend("manual-espo-compose", ledger), false);
});

test("mail-sync cutover ignores historical Sent-folder rows", () => {
  const cursor = new Date("2026-07-18T16:05:00Z");
  assert.equal(isAfterMailSyncCursor("2026-07-18T16:04:59Z", cursor), false);
  assert.equal(isAfterMailSyncCursor("2026-07-18T16:05:01Z", cursor), true);
  assert.equal(isAfterMailSyncCursor(undefined, cursor), false);
});
