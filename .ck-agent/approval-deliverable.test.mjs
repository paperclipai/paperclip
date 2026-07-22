import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalDeliverable,
  saveApprovalDeliverable,
} from "./approval-deliverable.mjs";

test("keeps the queued approval draft visible as the issue deliverable", () => {
  assert.equal(
    buildApprovalDeliverable({
      to: "venue@example.ch",
      subject: "Degustation",
      body: "Guten Tag\n\nDarf ich Ihnen Tres Hermanos vorstellen?",
    }),
    "To: venue@example.ch\nSubject: Degustation\n\nGuten Tag\n\nDarf ich Ihnen Tres Hermanos vorstellen?",
  );
});

test("does not replace a deliverable with an empty approval body", () => {
  assert.equal(buildApprovalDeliverable({ to: "venue@example.ch", body: " " }), null);
});

test("updates an existing deliverable with its current revision id", async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { latestRevisionId: "11111111-1111-4111-8111-111111111111" };
    return { latestRevisionId: "22222222-2222-4222-8222-222222222222" };
  };

  const result = await saveApprovalDeliverable(
    api,
    "issue-id",
    { to: "venue@example.ch", subject: "Neu", body: "Guten Tag" },
    { title: "REV-06 — deliverable" },
  );

  assert.equal(result.saved, true);
  assert.equal(calls[1].body.baseRevisionId, "11111111-1111-4111-8111-111111111111");
  assert.match(calls[1].body.body, /^To: venue@example\.ch\nSubject: Neu/);
});

test("retries a raced document update against the new current revision", async () => {
  let reads = 0;
  let writes = 0;
  const api = async (method, _path, body) => {
    if (method === "GET") {
      reads += 1;
      return { latestRevisionId: reads === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222" };
    }
    writes += 1;
    if (writes === 1) {
      const error = new Error("conflict");
      error.status = 409;
      throw error;
    }
    assert.equal(body.baseRevisionId, "22222222-2222-4222-8222-222222222222");
    return { latestRevisionId: "33333333-3333-4333-8333-333333333333" };
  };

  const result = await saveApprovalDeliverable(
    api,
    "issue-id",
    { to: "venue@example.ch", subject: "Neu", body: "Guten Tag" },
  );

  assert.equal(result.saved, true);
  assert.equal(reads, 2);
  assert.equal(writes, 2);
});
