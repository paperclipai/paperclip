import { describe, expect, it } from "vitest";

import {
  StartupRefusalError,
  migrationRefusalError,
  shouldReportStartupFailure,
} from "../startup-refusals.ts";

describe("migrationRefusalError", () => {
  const message = "PostgreSQL has pending migrations (…). Refusing to start.";

  it("classifies a never-migrated database as a supervised-transient refusal", () => {
    const error = migrationRefusalError({ appliedMigrations: [], tableCount: 0 }, message);
    expect(error).toBeInstanceOf(StartupRefusalError);
    expect((error as StartupRefusalError).kind).toBe("schema-not-yet-migrated");
    expect(error.message).toContain("Refusing to start");
  });

  it("keeps pending migrations on a migrated database as a plain, always-reported error", () => {
    const error = migrationRefusalError(
      { appliedMigrations: ["0000_init.sql"], tableCount: 41 },
      message,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StartupRefusalError);
  });

  it("treats an empty journal beside existing tables as drift, not a fresh database", () => {
    // A wiped or never-populated migration journal next to real tables is
    // a persistent failure; it must keep reporting.
    const error = migrationRefusalError({ appliedMigrations: [], tableCount: 17 }, message);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StartupRefusalError);
  });
});

describe("shouldReportStartupFailure", () => {
  const refusal = new StartupRefusalError(
    "database-contract-unmet",
    "authenticated public deployments require DATABASE_URL",
  );

  it("always reports non-refusal startup failures, managed cloud or not", () => {
    expect(shouldReportStartupFailure(new Error("boom"), {})).toBe(true);
    expect(
      shouldReportStartupFailure(new Error("boom"), {
        PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.com",
      }),
    ).toBe(true);
  });

  it("reports supervised-transient refusals outside managed-cloud deployments", () => {
    expect(shouldReportStartupFailure(refusal, {})).toBe(true);
  });

  it("suppresses supervised-transient refusals when a cloud supervisor owns the deployment", () => {
    expect(
      shouldReportStartupFailure(refusal, {
        PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.com",
      }),
    ).toBe(false);
  });

  it("treats a blank cloud origin as unset", () => {
    expect(shouldReportStartupFailure(refusal, { PAPERCLIP_CLOUD_API_ORIGIN: "   " })).toBe(true);
  });

  it("reports non-Error throwables unconditionally", () => {
    expect(
      shouldReportStartupFailure("string failure", {
        PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.com",
      }),
    ).toBe(true);
  });
});
