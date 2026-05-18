// @vitest-environment node

import { describe, expect, it } from "vitest";
import { EAOS_ALL_NAV_PATHS, EAOS_KERNEL_NAV, EAOS_PRIMARY_NAV } from "./nav-zones";

// LET-164 §4 lists the ten primary zones in this exact order. The shell
// renders them in this order via the array, so regressions in the array
// will visibly reorder the nav.
const EXPECTED_ORDER = [
  "Command Center",
  "Projects / Goals",
  "Missions",
  "Agents / Teams",
  "Runs / Observability",
  "Approvals / Risk",
  "Capabilities / MCP",
  "Sandbox / Runtime",
  "Knowledge / Playbooks",
  "Admin / Security",
];

describe("EAOS primary nav", () => {
  it("matches the LET-164 §4 zone order", () => {
    expect(EAOS_PRIMARY_NAV.map((zone) => zone.label)).toEqual(EXPECTED_ORDER);
  });

  it("anchors Command Center at /eaos", () => {
    expect(EAOS_PRIMARY_NAV[0]?.path).toBe("/eaos");
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
