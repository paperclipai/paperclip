import { describe, expect, it, vi } from "vitest";
import { pluginRegistryService } from "../services/plugin-registry.js";

function entity(index: number) {
  return {
    companyId: "11111111-1111-4111-8111-111111111111",
    entityType: "human-profile",
    scopeKind: "company" as const,
    scopeId: "11111111-1111-4111-8111-111111111111",
    externalId: `person-${index}`,
    data: { index },
  };
}

describe("plugin registry entity batch bounds", () => {
  it("allows the 5,001-record transactional batch required by a bounded replacement import", async () => {
    const transaction = vi.fn(async () => []);
    const registry = pluginRegistryService({ transaction } as never);

    await expect(
      registry.upsertEntities("plugin-record-id", Array.from({ length: 5_001 }, (_value, index) => entity(index))),
    ).resolves.toEqual([]);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects batches above the 10,000-record replacement ceiling before opening a transaction", async () => {
    const transaction = vi.fn(async () => []);
    const registry = pluginRegistryService({ transaction } as never);

    await expect(
      registry.upsertEntities("plugin-record-id", Array.from({ length: 10_001 }, (_value, index) => entity(index))),
    ).rejects.toThrow("exceeds 10000 records");
    expect(transaction).not.toHaveBeenCalled();
  });
});
