import test from "node:test";
import assert from "node:assert/strict";
import { classifyAction } from "../src/policy.mjs";

test("classifies protected action categories and drops unknown categories", () => {
  assert.deepEqual(classifyAction({ categories: ["money", "future_category", "credentials"] }), {
    protected: true,
    categories: ["money", "credentials"],
  });
});

test("classifies actions without protected categories as unprotected", () => {
  assert.deepEqual(classifyAction({ categories: ["read_only"] }), { protected: false, categories: [] });
});

test("classifies Paperclip owner-approval types as protected", () => {
  assert.deepEqual(classifyAction({ type: "budget_override_required" }), {
    protected: true,
    categories: ["money"],
  });
  assert.deepEqual(classifyAction({ type: "request_board_approval" }), {
    protected: true,
    categories: [],
  });
});

test("keeps unknown approval metadata fail-closed", () => {
  assert.deepEqual(classifyAction({ type: "future_approval_type" }), { protected: "Unknown", categories: [] });
  assert.deepEqual(classifyAction({ categories: ["future_category"] }), { protected: "Unknown", categories: [] });
  assert.deepEqual(classifyAction({ type: "__proto__" }), { protected: "Unknown", categories: [] });
});
