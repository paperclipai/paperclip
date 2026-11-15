import assert from "node:assert/strict";
import test from "node:test";
import type { ExportJsonlRecord } from "../../server/src/services/company-memory-upgrade/export-contract.js";
import {
  applyDeterministicFilter,
  DETERMINISTIC_FILTER_RULES,
} from "../../server/src/services/company-memory-upgrade/filter-rules.js";

function makeRecord(text: string): ExportJsonlRecord {
  return {
    import_key: "00000000-0000-4000-8000-000000000001",
    company_id: "00000000-0000-4000-8000-000000000002",
    agent_id: "00000000-0000-4000-8000-000000000003",
    text,
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "test",
    confidence: 0.9,
    migrated_from: "00000000-0000-4000-8000-000000000004",
    migration_id: "00000000-0000-4000-8000-000000000005",
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };
}

test("Deterministic Filter Rules Advanced (Rules 5-8 & Invariants)", async (t) => {
  await t.test("rule_no_assigned_tasks matches zero-task reports", () => {
    const positive = [
      "No assigned tasks.",
      "Currently has no assigned tasks.",
      "There are no assigned tasks",
      "No tasks assigned currently.",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_no_assigned_tasks");
    }
  });

  await t.test("rule_made_no_changes matches zero-change reports", () => {
    const positive = [
      "Made no changes.",
      "No changes were made during this run.",
      "Did not make any changes.",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_made_no_changes");
    }
  });

  await t.test("rule_no_new_memories_saved matches zero-memory lines", () => {
    const positive = [
      "No new memories saved.",
      "No new memories were saved.",
      "Zero memories recorded.",
      "No memories to save.",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_no_new_memories_saved");
    }
  });

  await t.test("rule_agent_instruction_echo matches system prompt echoes", () => {
    const positive = [
      "You are an autonomous AI agent.",
      "Follow the instructions in AGENTS.md.",
      "Never print DSNs or secrets.",
      "Operating instructions for agent.",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_agent_instruction_echo");
    }
  });

  await t.test("conservative invariant: never drops durable knowledge", () => {
    const durable = [
      "Dan Costanza decided to use PostgreSQL for the upgrade ledger.",
      "User prefers dark mode in the dashboard.",
      "The billing API requires an idempotency key header on POST requests.",
      "To deploy to production, verify all CI checks and run release script.",
      "Failure mode: Postgres connections leak if end() is omitted on error.",
    ];
    for (const text of durable) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.equal(match, null, `Durable fact must not match any rule: ${text}`);
    }
  });

  await t.test("all deterministic rules have description, example, and unique ID", () => {
    const ids = new Set<string>();
    for (const rule of DETERMINISTIC_FILTER_RULES) {
      assert.ok(rule.id.length > 0);
      assert.ok(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`);
      ids.add(rule.id);
      assert.ok(rule.description.length > 0);
      assert.ok(rule.example.length > 0);
      assert.ok(rule.match(rule.example, makeRecord(rule.example)), `Rule ${rule.id} must match its own example`);
    }
  });
});
