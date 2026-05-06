import { describe, expect, it } from "vitest";

import { goalService } from "../services/goals.ts";

function makeExplodingDb() {
  const explode = () => {
    throw new Error("db should not be queried for malformed UUIDs");
  };
  const handler: ProxyHandler<object> = {
    get() {
      return explode;
    },
  };
  return new Proxy({}, handler) as never;
}

const MALFORMED_IDS = ["not-a-uuid", "", "   ", "1234", "abc-def"];

describe("goalService.getById UUID guard (ZERA-527)", () => {
  const svc = goalService(makeExplodingDb());

  for (const value of MALFORMED_IDS) {
    it(`returns null without hitting the DB for "${value}"`, async () => {
      await expect(svc.getById(value)).resolves.toBeNull();
    });
  }
});
