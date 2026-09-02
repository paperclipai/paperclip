import { describe, expect, it } from "vitest";
import { databaseClientOptionsFromEnv, postgresJsOptions } from "./client.js";

describe("databaseClientOptionsFromEnv", () => {
  it("returns no options when nothing is set, preserving driver defaults", () => {
    expect(databaseClientOptionsFromEnv({})).toEqual({});
    expect(postgresJsOptions(databaseClientOptionsFromEnv({}))).toEqual({});
  });

  it("ignores empty values", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_PREPARED_STATEMENTS: "",
        DATABASE_POOL_MAX: "",
      }),
    ).toEqual({});
  });

  it("parses prepared-statement toggles", () => {
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "false" })).toEqual({ prepare: false });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "0" })).toEqual({ prepare: false });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "true" })).toEqual({ prepare: true });
    expect(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "TRUE" })).toEqual({ prepare: true });
  });

  it("parses pool and timeout settings", () => {
    expect(
      databaseClientOptionsFromEnv({
        DATABASE_POOL_MAX: "25",
        DATABASE_IDLE_TIMEOUT_SECONDS: "60",
        DATABASE_CONNECT_TIMEOUT_SECONDS: "10",
      }),
    ).toEqual({ maxConnections: 25, idleTimeoutSeconds: 60, connectTimeoutSeconds: 10 });
  });

  it("rejects malformed values instead of silently ignoring them", () => {
    expect(() => databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "maybe" })).toThrow(
      /DATABASE_PREPARED_STATEMENTS/,
    );
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_POOL_MAX: "-3" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => databaseClientOptionsFromEnv({ DATABASE_CONNECT_TIMEOUT_SECONDS: "1.5" })).toThrow(
      /DATABASE_CONNECT_TIMEOUT_SECONDS/,
    );
  });

  it("maps to postgres.js option names", () => {
    expect(
      postgresJsOptions({
        prepare: false,
        maxConnections: 25,
        idleTimeoutSeconds: 60,
        connectTimeoutSeconds: 10,
      }),
    ).toEqual({ prepare: false, max: 25, idle_timeout: 60, connect_timeout: 10 });
  });
});
