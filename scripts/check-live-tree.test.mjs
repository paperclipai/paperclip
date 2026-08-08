import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateLiveTree } from "./check-live-tree.mjs";

const codes = (result) => result.violations.map((violation) => violation.code).sort();

test("a clean live tree parked on master is the only healthy state", () => {
  const result = evaluateLiveTree({
    branch: "master",
    dirtyPaths: [],
    integrationInProgress: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), []);
});

// The LOOA-371 outage itself: an in-progress feature sitting uncommitted in the
// live tree, which `tsx watch` hot-reloaded into the running server mid-edit.
test("uncommitted work in the live tree is a violation -- every save is a deploy", () => {
  const result = evaluateLiveTree({
    branch: "master",
    dirtyPaths: ["server/src/routes/issues.ts", "server/src/services/issue-assignees.ts"],
    integrationInProgress: false,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["dirty"]);
  assert.match(result.violations[0].detail, /server\/src\/routes\/issues\.ts/);
});

// The state the live tree was actually found in: clean, but checked out on a
// feature branch -- so the server was serving unreviewed code.
test("a clean live tree on a feature branch is still a violation -- it is serving that branch", () => {
  const result = evaluateLiveTree({
    branch: "paperclip-looa368-reject-unresolved-skills",
    dirtyPaths: [],
    integrationInProgress: false,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["off-master"]);
});

test("both faults are reported together, not just the first", () => {
  const result = evaluateLiveTree({
    branch: "some-feature",
    dirtyPaths: ["server/src/index.ts"],
    integrationInProgress: false,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["dirty", "off-master"]);
});

// Merging is how master is *supposed* to advance, and a merge legitimately
// leaves the tree dirty. Flagging it would train everyone to ignore the check.
test("an in-flight integration is transient, not a violation", () => {
  const result = evaluateLiveTree({
    branch: "master",
    dirtyPaths: ["server/src/routes/issues.ts"],
    integrationInProgress: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.transient, true);
});

test("dirtyPaths is truncated in the message but fully counted", () => {
  const dirtyPaths = Array.from({ length: 14 }, (_, index) => `file-${index}.ts`);
  const result = evaluateLiveTree({ branch: "master", dirtyPaths, integrationInProgress: false });

  assert.equal(result.ok, false);
  assert.match(result.violations[0].detail, /^14 uncommitted path\(s\)/);
  assert.match(result.violations[0].detail, /\.\.\.$/);
});
