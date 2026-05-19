// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  EAOS_ALL_NAV_PATHS,
  EAOS_KERNEL_NAV,
  EAOS_LEGACY_SECONDARY_PATHS,
  EAOS_PRIMARY_NAV,
  EAOS_PRIMARY_NAV_ZONES,
} from "./nav-zones";

// LET-503 — LET-502 contract §2 collapses the rail to single-noun labels
// with no slashes and lists `Org` as a first-class route. Kernel/Admin is
// no longer a primary-rail entry; it lives under Admin → Legacy kernel.
const EXPECTED_PRIMARY_LABELS = [
  "Dashboard",
  "Missions",
  "Agents",
  "Org",
  "Projects",
  "Runs",
  "Approvals",
  "Knowledge",
  "Agent Builder",
  "Admin",
];

describe("EAOS primary nav (LET-503)", () => {
  it("renders single-noun labels with no slash compounds", () => {
    expect(EAOS_PRIMARY_NAV.map((zone) => zone.label)).toEqual(EXPECTED_PRIMARY_LABELS);
    for (const zone of EAOS_PRIMARY_NAV) {
      expect(zone.label).not.toMatch(/\s\/\s/);
    }
  });

  it("matches the combined PRIMARY_NAV iteration source", () => {
    expect(EAOS_PRIMARY_NAV_ZONES.map((zone) => zone.label)).toEqual(EXPECTED_PRIMARY_LABELS);
  });

  it("anchors Dashboard at /eaos and Org as a first-class route", () => {
    expect(EAOS_PRIMARY_NAV[0]?.path).toBe("/eaos");
    expect(EAOS_PRIMARY_NAV.find((zone) => zone.id === "org")?.path).toBe("/eaos/org");
  });

  it("roots every primary zone under /eaos", () => {
    for (const zone of EAOS_PRIMARY_NAV) {
      expect(zone.path.startsWith("/eaos")).toBe(true);
    }
  });

  it("does NOT include kernel/admin in the primary rail", () => {
    expect(EAOS_PRIMARY_NAV.find((zone) => zone.id === "kernel-admin")).toBeUndefined();
  });
});

describe("EAOS kernel/admin legacy link", () => {
  it("still points at the legacy /dashboard board route", () => {
    expect(EAOS_KERNEL_NAV.path).toBe("/dashboard");
  });

  it("labels the link as Legacy kernel for Admin reuse", () => {
    expect(EAOS_KERNEL_NAV.label).toBe("Legacy kernel");
  });
});

describe("EAOS_ALL_NAV_PATHS", () => {
  it("includes the kernel path so secret-sweep tests cover it", () => {
    expect(EAOS_ALL_NAV_PATHS).toContain(EAOS_KERNEL_NAV.path);
  });

  it("includes every primary-rail path", () => {
    for (const zone of EAOS_PRIMARY_NAV) {
      expect(EAOS_ALL_NAV_PATHS).toContain(zone.path);
    }
  });
});

describe("Legacy secondary surfaces", () => {
  it("keeps capabilities + sandbox routes reachable from outside the primary rail", () => {
    expect(EAOS_LEGACY_SECONDARY_PATHS).toContain("/eaos/capabilities");
    expect(EAOS_LEGACY_SECONDARY_PATHS).toContain("/eaos/sandbox");
  });
});
