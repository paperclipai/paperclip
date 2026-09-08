import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS,
  CapabilityMockSemanticConformanceAdapter,
} from "./capability-semantic-conformance.js";
import { runSemanticConformanceKit } from "./semantic-conformance.js";

const opened: CapabilityMockSemanticConformanceAdapter[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((adapter) => adapter.stop()));
});

describe("capability semantic conformance vectors", () => {
  it("produce stable normalized high-risk writes and denials", async () => {
    const first = await CapabilityMockSemanticConformanceAdapter.create();
    const second = await CapabilityMockSemanticConformanceAdapter.create();
    opened.push(first, second);

    const report = await runSemanticConformanceKit({
      vectors: CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS,
      adapters: [first, { ...second, id: "capability-mock-replay", execute: second.execute.bind(second) }],
    });

    const authorizations = Object.fromEntries(
      report.rows.map((row) => [row.vectorId, row.observation.authorization]),
    );
    expect(authorizations).toMatchObject({
      "governed-action-without-claim": { outcome: "denied", code: "required_claim_missing" },
      "protected-input-redaction": { outcome: "denied", code: "protected_data_denied" },
      "cross-company-dependency-denial": { outcome: "denied", code: "company_scope_violation" },
      "progress-applied": { outcome: "allowed" },
      "progress-duplicate-retry": { outcome: "allowed" },
      "progress-idempotency-conflict": { outcome: "denied", code: "idempotency_conflict" },
      "document-create": { outcome: "allowed" },
      "document-stale-revision": { outcome: "denied", code: "document_revision_conflict" },
      "continuation-request": { outcome: "allowed" },
      "terminal-with-dependency": { outcome: "allowed" },
      "terminal-finish": { outcome: "allowed" },
    });
    expect(report.rows.find((row) => row.vectorId === "progress-duplicate-retry")?.observation)
      .toMatchObject({ effects: [{ disposition: "duplicate" }], audit: [] });
    expect(report.rows.find((row) => row.vectorId === "continuation-request")?.observation.state)
      .toMatchObject({
        task: { status: "in_review" },
        interactions: [{ continuationPolicy: "wake_assignee", status: "pending" }],
      });
    expect(report.rows.find((row) => row.vectorId === "terminal-finish")?.observation.state)
      .toMatchObject({ task: { status: "done" } });
    expect(report.rows.find((row) => row.vectorId === "terminal-with-dependency")?.observation.state)
      .toMatchObject({ task: { status: "done" }, dependencies: [expect.any(String)] });
    expect(report.rows.every((row) => row.observation.receipt?.operationReceiptPresent === true))
      .toBe(true);
    expect(report.rows.find((row) => row.vectorId === "document-stale-revision")?.observation.receipt)
      .toMatchObject({ outcome: "conflict", authorizationBoundary: "revision", retryable: false });
  });
});
