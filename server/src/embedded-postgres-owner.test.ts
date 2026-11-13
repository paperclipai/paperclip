import { expect, it } from "vitest";
import { embeddedPostgresOwnerPort } from "./embedded-postgres-owner.js";
it("uses the running cluster's selected port after a collision", () => {
  expect(embeddedPostgresOwnerPort("123\n/data/qa\n123456\n54330\n", "/data/qa", 123)).toBe(54330);
});
it.each(["124\n/data/qa\n123456\n54330\n", "123\n/data/other\n123456\n54330\n", "123\n/data/qa\n123456\n0\n", "123\n/data/qa\n"])("rejects inconsistent ownership %j", contents => {
  expect(() => embeddedPostgresOwnerPort(contents, "/data/qa", 123)).toThrow("does not match");
});
