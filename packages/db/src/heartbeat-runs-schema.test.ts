import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { heartbeatRuns } from "./schema/heartbeat_runs.js";

describe("heartbeat run schema", () => {
  it("covers the wakeup request foreign key with an index", () => {
    const table = getTableConfig(heartbeatRuns);
    const foreignKey = table.foreignKeys.find((candidate) =>
      candidate.reference().columns.map((column) => column.name).join(",") === "wakeup_request_id",
    );

    expect(foreignKey).toBeDefined();
    const covering = table.indexes.filter((candidate) =>
      (candidate.config.columns[0] as { name?: string } | undefined)?.name === "wakeup_request_id",
    );

    expect(covering).toHaveLength(1);
    expect(covering[0]?.config.concurrently).toBe(true);
    expect(covering[0]?.config.where).toBeUndefined();
  });
});
