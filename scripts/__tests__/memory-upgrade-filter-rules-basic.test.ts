import assert from "node:assert/strict";
import test from "node:test";
import type { ExportJsonlRecord } from "../../server/src/services/company-memory-upgrade/export-contract.js";
import { applyDeterministicFilter } from "../../server/src/services/company-memory-upgrade/filter-rules.js";

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

test("Deterministic Filter Rules Basic (Rules 1-6)", async (t) => {
  await t.test("rule_run_identifier_or_uuid matches bare UUID and headers", () => {
    const positive = [
      "550e8400-e29b-41d4-a716-446655440000",
      "Run ID: 550e8400-e29b-41d4-a716-446655440000",
      "heartbeat run 550e8400-e29b-41d4-a716-446655440000",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_run_identifier_or_uuid");
    }
  });

  await t.test("rule_run_id_statement matches named agent run ID statements", () => {
    const positive = [
      "Talent run ID is 550e8400-e29b-41d4-a716-446655440000.",
      "Chief run ID is 550e8400-e29b-41d4-a716-446655440000",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_run_id_statement");
    }
  });

  await t.test("rule_api_base_url matches only explicit API base statements with local/api hosts", () => {
    const positive = [
      "Paperclip API base is http://127.0.0.1:3100/api.",
      "API base URL is https://api.paperclip.ai/api/v1",
      "API base is http://localhost:8080/api",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_api_base_url");
    }

    // Generic and doc URLs must NOT be dropped deterministically
    const negative = [
      "https://api.paperclip.ai/v1",
      "Documentation available at https://docs.paperclip.ai/guides/api.",
      "Paperclip API base is https://docs.paperclip.ai/guides",
    ];
    for (const text of negative) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.equal(match, null, `Should not match rule_api_base_url: ${text}`);
    }
  });

  await t.test("rule_ticket_marked_done matches ticket complete statements", () => {
    const positive = [
      "ENG-123 is complete and marked done.",
      "TECH-8572 is complete and marked done.",
      "PAPA-402 is complete and marked done",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_ticket_marked_done");
    }

    // Run report / coverage report sentences must not match
    const negative = [
      "Run report: ENG-123 is complete and marked done.",
      "Coverage report indicates 100% test completion.",
    ];
    for (const text of negative) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.notEqual(match?.id, "rule_ticket_marked_done");
    }
  });

  await t.test("rule_wake_trigger_reason matches operational triggers", () => {
    const positive = [
      "Wake reason: periodic heartbeat",
      "Triggered by cron schedule",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_wake_trigger_reason");
    }
  });

  await t.test("rule_status_complete_marked_done matches status lines", () => {
    const positive = [
      "Task is complete.",
      "Issue marked done.",
      "Completed task execution.",
    ];
    for (const text of positive) {
      const match = applyDeterministicFilter(makeRecord(text));
      assert.ok(match, `Expected match for: ${text}`);
      assert.equal(match.id, "rule_status_complete_marked_done");
    }
  });
});
