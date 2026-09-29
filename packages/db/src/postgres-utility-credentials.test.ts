import { expect, it } from "vitest";
import { postgresUtilityConnection } from "./backup-lib.js";

it("keeps database passwords out of utility arguments and other credentials out of children", () => {
  const { connectionString, env } = postgresUtilityConnection("postgresql://worker:fixture%3Apassword@localhost/example?sslmode=require", {
    PAPERCLIP_DECLARATIVE: "true", PATH: "/bin", BETTER_AUTH_SECRET: "unrelated", DATABASE_MIGRATION_URL: "unrelated", PROVIDER_API_KEY: "unrelated",
  });
  expect(connectionString).toBe("postgresql://worker@localhost/example?sslmode=require");
  expect(env).toEqual({ PATH: "/bin", PGPASSWORD: "fixture:password" });
});
