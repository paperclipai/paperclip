import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentWakeupRequests } from "./schema/agent_wakeup_requests.js";

describe("agent wakeup request schema", () => {
  it("atomically deduplicates review-path recovery fingerprints per company", () => {
    const index = getTableConfig(agentWakeupRequests).indexes.find(
      (candidate) => candidate.config.name === "agent_wakeup_requests_review_path_recovery_idempotency_uq",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "company_id",
      "idempotency_key",
    ]);
    expect(index?.config.where).toBeDefined();
  });

  it("atomically deduplicates disposition-repair attempts per company", () => {
    const index = getTableConfig(agentWakeupRequests).indexes.find(
      (candidate) => candidate.config.name === "agent_wakeup_requests_disposition_repair_idempotency_uq",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "company_id",
      "idempotency_key",
    ]);
    expect(index?.config.where).toBeDefined();
  });
});
