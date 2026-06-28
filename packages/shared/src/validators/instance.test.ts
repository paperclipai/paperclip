import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  instanceGeneralSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "./instance.js";

describe("instance validators", () => {
  describe("instanceExperimentalSettingsSchema", () => {
    it("parses a stored DB row containing unknown legacy keys without dropping known flags", () => {
      // Mirrors the production case where instance_settings.experimental
      // contains an orphan key (e.g. enableCloudSync) that no longer exists
      // in the schema. Parsing must succeed and preserve enableIsolatedWorkspaces.
      const stored = {
        enableCloudSync: true,
        enableEnvironments: true,
        enableIsolatedWorkspaces: true,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: false,
      };

      const parsed = instanceExperimentalSettingsSchema.safeParse(stored);

      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const parsedData = parsed.data as Record<string, unknown> & { enableCloudSync?: unknown };
      expect(parsedData.enableIsolatedWorkspaces).toBe(true);
      expect(parsedData.enableEnvironments).toBe(true);
      expect(parsedData.enableCloudSync).toBeUndefined();
    });

    it("does not throw on unknown keys (intentional strip, not strict)", () => {
      expect(() =>
        instanceExperimentalSettingsSchema.parse({
          enableIsolatedWorkspaces: true,
          legacyKeyThatNoLongerExists: "whatever",
        }),
      ).not.toThrow();
    });

    it("applies defaults when fields are missing", () => {
      const parsed = instanceExperimentalSettingsSchema.parse({});
      expect(parsed).toEqual({
        enableEnvironments: false,
        enableIsolatedWorkspaces: false,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: false,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      });
    });

    it("rejects out-of-range lookback hours", () => {
      const tooSmall = instanceExperimentalSettingsSchema.safeParse({
        issueGraphLivenessAutoRecoveryLookbackHours: 0,
      });
      expect(tooSmall.success).toBe(false);

      const tooBig = instanceExperimentalSettingsSchema.safeParse({
        issueGraphLivenessAutoRecoveryLookbackHours: 10000,
      });
      expect(tooBig.success).toBe(false);
    });

    it("partial patch schema accepts subset of fields", () => {
      const parsed = patchInstanceExperimentalSettingsSchema.parse({
        enableIsolatedWorkspaces: true,
      });
      expect(parsed.enableIsolatedWorkspaces).toBe(true);
      expect(parsed.enableEnvironments).toBeUndefined();
    });
  });

  describe("instanceGeneralSettingsSchema", () => {
    it("rejects unknown keys (strict by design for user-supplied patches)", () => {
      const result = instanceGeneralSettingsSchema.safeParse({
        keyboardShortcuts: true,
        unknownKey: "nope",
      });
      expect(result.success).toBe(false);
    });

    it("parses well-formed general settings", () => {
      const parsed = instanceGeneralSettingsSchema.parse({
        keyboardShortcuts: true,
        censorUsernameInLogs: false,
      });
      expect(parsed.keyboardShortcuts).toBe(true);
    });

    it("partial patch schema accepts subset of fields", () => {
      const parsed = patchInstanceGeneralSettingsSchema.parse({
        keyboardShortcuts: false,
      });
      expect(parsed.keyboardShortcuts).toBe(false);
    });
  });
});
