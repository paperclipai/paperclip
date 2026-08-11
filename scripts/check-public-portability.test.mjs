import assert from "node:assert/strict";
import test from "node:test";

import { collectViolations } from "./check-public-portability.mjs";

const snapshot = "packages/db/src/migrations/meta/0207_snapshot.json";
const UUID = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");

function scan(added, paths = []) {
  return collectViolations(added, paths);
}

test("allows only generated snapshot top-level identities", () => {
  assert.deepEqual(scan([
    { file: snapshot, line: 2, text: `  "id": "${UUID}",` },
    { file: snapshot, line: 3, text: `  "prevId": "${UUID}"` },
  ]), []);
  assert.equal(scan([{ file: snapshot, line: 4, text: `  "columnId": "${UUID}"` }])[0].marker, "bare-uuid");
});

test("allows package specifiers but scans the rest of their line", () => {
    assert.deepEqual(scan([{ file: "packages/example.ts", line: 1, text: 'import { db } from "@paperclip' + 'ai/db";' }]), []);
  assert.equal(scan([{ file: "packages/example.ts", line: 1, text: 'import "@paperclip' + 'ai/db"; const endpoint = "paperclip' + '.ing";' }])[0].marker, "internal-host-or-url");
});

test("rejects non-package private markers and compact issue forms", () => {
  assert.equal(scan([{ file: "note.txt", line: 1, text: "paperclip" + "ai.headroom-compress" }])[0].marker, "internal-host-or-url");
  assert.equal(scan([{ file: "note.txt", line: 1, text: UUID }])[0].marker, "bare-uuid");
  assert.equal(scan([{ file: "note.txt", line: 1, text: "sAg" + "3482" }])[0].marker, "internal-issue-id");
  assert.equal(scan([], ["enrichment/backfill_sag" + "3482.py"])[0].marker, "internal-issue-id");
});

test("rejects supported nested package-manager lockfiles", () => {
  for (const path of ["review-ui/package-lock.json", "tools/yarn.lock", "nested/pnpm-lock.yaml", "nested/bun.lockb"]) {
    assert.equal(scan([], [path])[0].marker, "nested-lockfile", path);
  }
  assert.deepEqual(scan([], ["pnpm-lock.yaml"]), []);
});
