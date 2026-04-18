import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "./auth.js";

describe("auth schema", () => {
  it("maps Better Auth tables to the expected public table names", () => {
    expect(getTableName(authUsers)).toBe("user");
    expect(getTableName(authSessions)).toBe("session");
    expect(getTableName(authAccounts)).toBe("auth_account");
    expect(getTableName(authVerifications)).toBe("verification");
  });
});
