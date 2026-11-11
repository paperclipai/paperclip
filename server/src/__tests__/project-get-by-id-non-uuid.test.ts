import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { projectService } from "../services/projects.ts";

describe("projectService.getById", () => {
  it("returns null for non-UUID references without querying the database", async () => {
    const db = new Proxy({}, {
      get() {
        throw new Error("database must not be queried for a non-UUID project id");
      },
    }) as unknown as Db;
    await expect(projectService(db).getById("onboarding")).resolves.toBeNull();
    await expect(projectService(db).getById("")).resolves.toBeNull();
  });
});
