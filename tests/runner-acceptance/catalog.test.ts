import { describe, expect, it } from "vitest";

import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { QUALIFIED_OPENCODE_MODEL } from "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.js";
import {
  directAcceptanceProfiles,
  nativeAcceptanceProfiles,
  runnerAcceptanceCases,
  runnerAcceptanceMatrix,
  validateRunnerAcceptanceCatalog,
} from "./catalog.js";

describe("credential-free Runner acceptance catalog", () => {
  it("covers direct adapters without activating the native runtime", () => {
    expect(directAcceptanceProfiles.length).toBeGreaterThan(10);
    expect(directAcceptanceProfiles.every((profile) =>
      profile.generation === "direct"
      && profile.expectedRuntimeMode === "legacy"
      && profile.invariants.includes("runnerd.start_count=0")
      && profile.invariants.includes("native_record.count=0"))).toBe(true);
    expect(directAcceptanceProfiles.some(({ adapterType }) => adapterType === "process")).toBe(true);
    expect(directAcceptanceProfiles.some(({ adapterType }) => adapterType === "http")).toBe(true);
    expect(directAcceptanceProfiles.some(({ adapterScope }) =>
      adapterScope === "external_plugin_contract")).toBe(true);
  });

  it("contains only the approved native providers and ACPX profiles", () => {
    expect(nativeAcceptanceProfiles.map(({ id }) => id)).toEqual([
      "runner-codex",
      "runner-opencode",
      "runner-acpx-claude",
      "runner-acpx-codex",
    ]);
    expect(nativeAcceptanceProfiles.find(({ id }) => id === "runner-opencode")?.model)
      .toBe(QUALIFIED_OPENCODE_MODEL);
    expect(nativeAcceptanceProfiles.find(({ id }) => id === "runner-acpx-claude")?.model)
      .toBe(QUALIFIED_ACPX_PROFILES.claude.qualificationModel);
    expect(nativeAcceptanceProfiles.find(({ id }) => id === "runner-acpx-codex")?.model)
      .toBe(QUALIFIED_ACPX_PROFILES.codex.qualificationModel);
    expect(nativeAcceptanceProfiles.some(({ adapterConfig }) =>
      adapterConfig.acpxAgent === "pi")).toBe(false);
    expect(directAcceptanceProfiles.some(({ adapterType }) =>
      adapterType === "pi_local")).toBe(false);
  });

  it("contains no launch authority, provider credentials, or managed providers", () => {
    const serialized = JSON.stringify({
      profiles: [...directAcceptanceProfiles, ...nativeAcceptanceProfiles],
      cases: runnerAcceptanceCases,
    });
    expect(serialized).not.toMatch(/claude_managed|aws_agentcore|daytona/i);
    expect(serialized).not.toMatch(/api.?key|secret_ref|authorization/i);
  });

  it("builds a stable, unique matrix and applies recovery only to native profiles", () => {
    expect(validateRunnerAcceptanceCatalog()).toEqual(runnerAcceptanceMatrix);
    expect(new Set(runnerAcceptanceMatrix.map(({ id }) => id)).size)
      .toBe(runnerAcceptanceMatrix.length);
    expect(runnerAcceptanceMatrix
      .filter(({ acceptanceCase }) => acceptanceCase.id === "flagged-native-recovery")
      .every(({ profile }) => profile.generation === "native"))
      .toBe(true);
  });
});
