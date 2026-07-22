import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedSendContent } from "./tools.js";

test("accepted task card uses the exact linked outbox copy", () => {
  const result = resolveApprovedSendContent(
    {},
    {
      detailsMarkdown: "**To:** stale@example.ch\n**Betreff:** Stale subject\n\nStale body",
    },
    {
      account_id: "account-1",
      to_email: "venue@example.ch",
      subject: "Alan's edited subject",
      body: "Alan's edited body",
    },
  );

  assert.deepEqual(result, {
    accountId: "account-1",
    to: "venue@example.ch",
    subject: "Alan's edited subject",
    body: "Alan's edited body",
  });
});

test("queue-style card details remain a safe fallback without a linked row", () => {
  const result = resolveApprovedSendContent(
    { account_id: "account-2" },
    {
      detailsMarkdown: "**To:** venue@example.ch\n**Betreff:** A subject\n\nGrüezi\n\nA body.",
    },
  );

  assert.deepEqual(result, {
    accountId: "account-2",
    to: "venue@example.ch",
    subject: "A subject",
    body: "Grüezi\n\nA body.",
  });
});
