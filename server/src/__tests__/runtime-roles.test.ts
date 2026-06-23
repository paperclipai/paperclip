import { describe, expect, it } from "vitest";
import { deriveRuntimeControls, parseRuntimeRole } from "../runtime-roles.js";

describe("runtime roles", () => {
  it("defaults to primary and preserves existing producer behavior", () => {
    const controls = deriveRuntimeControls({
      databaseBackupEnabled: true,
      feedbackExporterConfigured: true,
    });

    expect(controls.role).toBe("primary");
    expect(controls.heartbeatSchedulerEnabled).toBe(true);
    expect(controls.routineSchedulerEnabled).toBe(true);
    expect(controls.pluginSchedulerEnabled).toBe(true);
    expect(controls.pluginWorkersEnabled).toBe(true);
    expect(controls.pluginAutoInstallEnabled).toBe(true);
    expect(controls.startupRecoveryEnabled).toBe(true);
    expect(controls.startupReconciliationEnabled).toBe(true);
    expect(controls.databaseBackupSchedulerEnabled).toBe(true);
    expect(controls.feedbackExporterEnabled).toBe(true);
    expect(controls.migrationsApplyAllowed).toBe(true);
  });

  it("rejects invalid roles with a clear startup error", () => {
    expect(() => parseRuntimeRole("secondary")).toThrow(
      "Invalid PAPERCLIP_RUNTIME_ROLE=\"secondary\"",
    );
  });

  it("keeps HEARTBEAT_SCHEDULER_ENABLED=false compatible in primary", () => {
    const controls = deriveRuntimeControls({
      role: "primary",
      heartbeatSchedulerEnv: "false",
      databaseBackupEnabled: true,
      feedbackExporterConfigured: true,
    });

    expect(controls.heartbeatSchedulerEnabled).toBe(false);
    expect(controls.routineSchedulerEnabled).toBe(false);
    expect(controls.startupRecoveryEnabled).toBe(false);
    expect(controls.pluginSchedulerEnabled).toBe(true);
    expect(controls.databaseBackupSchedulerEnabled).toBe(true);
  });

  it("disables work-producing systems in staged", () => {
    const controls = deriveRuntimeControls({
      role: "staged",
      databaseBackupEnabled: true,
      feedbackExporterConfigured: true,
    });

    expect(controls.heartbeatSchedulerEnabled).toBe(false);
    expect(controls.routineSchedulerEnabled).toBe(false);
    expect(controls.startupRecoveryEnabled).toBe(false);
    expect(controls.startupReconciliationEnabled).toBe(false);
    expect(controls.pluginSchedulerEnabled).toBe(false);
    expect(controls.pluginWorkersEnabled).toBe(false);
    expect(controls.pluginAutoInstallEnabled).toBe(false);
    expect(controls.databaseBackupSchedulerEnabled).toBe(false);
    expect(controls.feedbackExporterEnabled).toBe(false);
    expect(controls.migrationsApplyAllowed).toBe(false);
    expect(controls.migrationMode).toBe("refuse");
  });

  it("disables background producers in api-only", () => {
    const controls = deriveRuntimeControls({
      role: "api-only",
      databaseBackupEnabled: true,
      feedbackExporterConfigured: true,
    });

    expect(controls.heartbeatSchedulerEnabled).toBe(false);
    expect(controls.routineSchedulerEnabled).toBe(false);
    expect(controls.startupRecoveryEnabled).toBe(false);
    expect(controls.pluginSchedulerEnabled).toBe(false);
    expect(controls.pluginWorkersEnabled).toBe(false);
    expect(controls.databaseBackupSchedulerEnabled).toBe(false);
    expect(controls.feedbackExporterEnabled).toBe(false);
    expect(controls.migrationsApplyAllowed).toBe(false);
  });

  it("allows scheduler systems in scheduler-only but blocks primary-only boot reconciliation", () => {
    const controls = deriveRuntimeControls({
      role: "scheduler-only",
      databaseBackupEnabled: true,
      feedbackExporterConfigured: true,
    });

    expect(controls.heartbeatSchedulerEnabled).toBe(true);
    expect(controls.routineSchedulerEnabled).toBe(true);
    expect(controls.startupRecoveryEnabled).toBe(true);
    expect(controls.pluginSchedulerEnabled).toBe(true);
    expect(controls.pluginWorkersEnabled).toBe(true);
    expect(controls.startupReconciliationEnabled).toBe(false);
    expect(controls.databaseBackupSchedulerEnabled).toBe(false);
    expect(controls.migrationsApplyAllowed).toBe(false);
  });
});
