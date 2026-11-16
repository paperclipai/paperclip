import { describe, expect, it, vi } from "vitest";
import { SchemaDriftError, type SchemaDriftReport } from "@paperclipai/db";
import {
  enforceSchemaDriftGate,
  readSchemaDriftEscapeHatch,
  type SchemaDriftGateLogger,
} from "./schema-drift-gate.js";

function makeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: SchemaDriftGateLogger = { info, warn, error };
  return { logger, info, warn, error };
}

const CLEAN_REPORT: SchemaDriftReport = {
  drifted: false,
  checkedTables: 42,
  missingTables: [],
  missingColumns: [],
};

const DRIFTED_REPORT: SchemaDriftReport = {
  drifted: true,
  checkedTables: 42,
  missingTables: [],
  missingColumns: [{ table: "companies", column: "attachment_max_bytes" }],
};

const SERVING_TARGET = { url: "postgres://live", label: "serving database (DATABASE_URL)" };

describe("enforceSchemaDriftGate", () => {
  it("passes and logs success when the live schema matches", async () => {
    const { logger, info, error } = makeLogger();
    const assertNoDrift = vi.fn().mockResolvedValue(CLEAN_REPORT);

    await expect(
      enforceSchemaDriftGate([SERVING_TARGET], { allowDrift: false, logger, assertNoDrift }),
    ).resolves.toBeUndefined();

    expect(assertNoDrift).toHaveBeenCalledWith(SERVING_TARGET.url);
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs the full drift report and refuses to start on drift (acceptance: server refuses start)", async () => {
    const { logger, error } = makeLogger();
    const assertNoDrift = vi.fn().mockRejectedValue(new SchemaDriftError(DRIFTED_REPORT));

    await expect(
      enforceSchemaDriftGate([SERVING_TARGET], { allowDrift: false, logger, assertNoDrift }),
    ).rejects.toThrow(/Refusing to start against a drifted schema/);

    expect(error).toHaveBeenCalledTimes(1);
    const [payload, message] = error.mock.calls[0];
    expect(payload).toMatchObject({
      target: SERVING_TARGET.label,
      missingColumns: [{ table: "companies", column: "attachment_max_bytes" }],
    });
    expect(message).toContain("companies.attachment_max_bytes");
  });

  it("downgrades the refusal to a warning when the escape hatch is set", async () => {
    const { logger, warn, error } = makeLogger();
    const assertNoDrift = vi.fn().mockRejectedValue(new SchemaDriftError(DRIFTED_REPORT));

    await expect(
      enforceSchemaDriftGate([SERVING_TARGET], { allowDrift: true, logger, assertNoDrift }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing startup despite schema drift"),
    );
  });

  it("checks every target and refuses on the first drifted one", async () => {
    const { logger } = makeLogger();
    const migrationTarget = {
      url: "postgres://migration",
      label: "plugin/migration database (DATABASE_MIGRATION_URL)",
    };
    const assertNoDrift = vi
      .fn()
      .mockResolvedValueOnce(CLEAN_REPORT)
      .mockRejectedValueOnce(new SchemaDriftError(DRIFTED_REPORT));

    await expect(
      enforceSchemaDriftGate([SERVING_TARGET, migrationTarget], {
        allowDrift: false,
        logger,
        assertNoDrift,
      }),
    ).rejects.toThrow(/plugin\/migration database/);

    expect(assertNoDrift).toHaveBeenNthCalledWith(1, SERVING_TARGET.url);
    expect(assertNoDrift).toHaveBeenNthCalledWith(2, migrationTarget.url);
  });

  it("propagates non-drift errors (e.g. unreachable database) unchanged", async () => {
    const { logger, error } = makeLogger();
    const connErr = new Error("ECONNREFUSED");
    const assertNoDrift = vi.fn().mockRejectedValue(connErr);

    await expect(
      enforceSchemaDriftGate([SERVING_TARGET], { allowDrift: false, logger, assertNoDrift }),
    ).rejects.toBe(connErr);

    expect(error).not.toHaveBeenCalled();
  });
});

describe("readSchemaDriftEscapeHatch", () => {
  it("is false by default", () => {
    expect(readSchemaDriftEscapeHatch({})).toBe(false);
  });

  it("honors the primary PAPERCLIP_ALLOW_SCHEMA_DRIFT flag", () => {
    expect(readSchemaDriftEscapeHatch({ PAPERCLIP_ALLOW_SCHEMA_DRIFT: "true" })).toBe(true);
  });

  it("honors the PAPERCLIP_SCHEMA_DRIFT_ALLOW alias", () => {
    expect(readSchemaDriftEscapeHatch({ PAPERCLIP_SCHEMA_DRIFT_ALLOW: "true" })).toBe(true);
  });

  it("only treats the exact string 'true' as enabled", () => {
    expect(readSchemaDriftEscapeHatch({ PAPERCLIP_ALLOW_SCHEMA_DRIFT: "1" })).toBe(false);
    expect(readSchemaDriftEscapeHatch({ PAPERCLIP_ALLOW_SCHEMA_DRIFT: "yes" })).toBe(false);
  });
});
