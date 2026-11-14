import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { projectService } from "../services/projects.ts";

function untouchableDb() {
  return new Proxy({}, {
    get() {
      throw new Error("database must not be queried for a non-UUID project id");
    },
  }) as unknown as Db;
}

function emptyResultDb(seen: string[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  return {
    select: () => {
      seen.push("select");
      return chain;
    },
  } as unknown as Db;
}

describe("projectService.getById", () => {
  it.each([
    "onboarding",
    "",
    "{11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111}",
    "}11111111-1111-4111-8111-111111111111{",
  ])("returns null for non-UUID reference %j without querying the database", async (id) => {
    await expect(projectService(untouchableDb()).getById(id)).resolves.toBeNull();
  });

  it.each([
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-1111-1111-111111111111",
    "00000000-0000-0000-0000-000000000000",
    "018f3b6e-7c1a-7d2e-9f00-123456789abc",
    "{11111111-1111-4111-8111-111111111111}",
    "11111111111141118111111111111111",
  ])("still queries the database for uuid-syntax id %s", async (id) => {
    const seen: string[] = [];
    await expect(projectService(emptyResultDb(seen)).getById(id)).resolves.toBeNull();
    expect(seen).toEqual(["select"]);
  });
});
