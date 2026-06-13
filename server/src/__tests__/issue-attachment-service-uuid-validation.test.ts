import { describe, expect, it } from "vitest";

import { issueService } from "../services/issues.ts";

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

describe("issueService.getAttachmentById UUID guard (ZERA-530)", () => {
  const svc = issueService(makeExplodingDb());

  for (const value of MALFORMED_IDS) {
    it(`returns null without hitting the DB for "${value}"`, async () => {
      await expect(svc.getAttachmentById(value)).resolves.toBeNull();
    });
  }
});
