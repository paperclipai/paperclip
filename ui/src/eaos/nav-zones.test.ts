// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  EAOS_ALL_NAV_PATHS,
  EAOS_KERNEL_NAV,
  EAOS_PRIMARY_NAV,
  EAOS_PRIMARY_NAV_ZONES,
  EAOS_SECONDARY_NAV_ZONES,
} from "./nav-zones";

// LET-459 §"IA principle: two product modes" promotes Missions into the
// operator tier and demotes Projects/Goals, Runs/Observability,
// Capabilities/MCP, Sandbox/Runtime, and Admin/Security into a Build/Admin
// tier so the default screen does not show ten equal links.
const EXPECTED_PRIMARY_TIER = [
  "Command Center",
  "Missions",
  "Agents / Teams",
  "Blueprints",
  "Approvals / Risk",
  "Knowledge / Playbooks",
];

const EXPECTED_SECONDARY_TIER = [
  "Projects / Goals",
  "Runs / Observability",
  "Capabilities / MCP",
  "Sandbox / Runtime",
  "Admin / Security",
];

describe("EAOS primary nav", () => {
  it("matches the LET-459 operator/build-admin grouping", () => {
    expect(EAOS_PRIMARY_NAV.map((zone) => zone.label)).toEqual([
      ...EXPECTED_PRIMARY_TIER,
      ...EXPECTED_SECONDARY_TIER,
    ]);
  });

  it("anchors Command Center at /eaos", () => {
    expect(EAOS_PRIMARY_NAV[0]?.path).toBe("/eaos");
  });

  it("keeps Missions in the operator tier per LET-459", () => {
    expect(EAOS_PRIMARY_NAV_ZONES.map((zone) => zone.label)).toEqual(EXPECTED_PRIMARY_TIER);
    for (const zone of EAOS_PRIMARY_NAV_ZONES) {
      expect(zone.tier).toBe("primary");
    }
  });

  it("demotes build/admin zones into the secondary tier", () => {
    expect(EAOS_SECONDARY_NAV_ZONES.map((zone) => zone.label)).toEqual(EXPECTED_SECONDARY_TIER);
    for (const zone of EAOS_SECONDARY_NAV_ZONES) {
      expect(zone.tier).toBe("secondary");
    }
  });

  it.each(EAOS_PRIMARY_NAV)(
    "ensures zone '%s' is rooted under /eaos and has a stub count",
    (zone) => {
      expect(zone.path.startsWith("/eaos")).toBe(true);
      expect(zone.stubCount).toBe(0);
    },
  );
});

describe("EAOS kernel/admin nav", () => {
  it("points the kernel escape hatch at the legacy /dashboard board route", () => {
    expect(EAOS_KERNEL_NAV.path).toBe("/dashboard");
  });
});

describe("EAOS_ALL_NAV_PATHS", () => {
  it("includes the kernel path so secret sweeps cover it", () => {
    expect(EAOS_ALL_NAV_PATHS).toContain(EAOS_KERNEL_NAV.path);
  });
});
