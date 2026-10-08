import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLifecycleWriteViolations } from "./check-agent-lifecycle-boundaries.mjs";
const source = body => `import { agents as records } from "@paperclipai/db"; ${body}`;
test("finds inserts, deletes, and lifecycle writes through an import alias", () => {
  for (const body of ["db.insert(records).values(input)", "db.delete(records)", "db.update(records).set({ lifecycleState: 'ready' })", "db.update(records).set({ pauseReason })"]) {
    assert.equal(agentLifecycleWriteViolations(source(body)).length, 1);
  }
});
test("permits configuration writes and guards execution status writes", () => {
  assert.deepEqual(agentLifecycleWriteViolations(source("db.update(records).set({ name })")), []);
  assert.equal(agentLifecycleWriteViolations(source("db.update(records).set({ status: 'idle' })")).length, 1);
  assert.deepEqual(agentLifecycleWriteViolations(source('db.update(records).set({ status: "idle" }).where(eq(records.lifecycleState, "ready"))')), []);
});
