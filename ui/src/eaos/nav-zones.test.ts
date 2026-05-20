// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  EAOS_ALL_NAV_PATHS,
  EAOS_KERNEL_NAV,
  EAOS_LEGACY_SECONDARY_PATHS,
  EAOS_NAV_GROUPS,
  EAOS_PRIMARY_NAV,
  EAOS_PRIMARY_NAV_ZONES,
} from "./nav-zones";

// LET-506 (Multica adaptation) — the rail is now grouped Personal /
// Workspace / Configure, and the Workspace group orders work surfaces by
// mission priority: Missions and Projects first (active work), then
// Agents/Org (org structure), then execution surfaces (Runs/Approvals/
// Knowledge). The LET-502 contract §2 invariants (single-noun labels,
// `Org` as a first-class route, no Kernel/Admin in the rail) are
// preserved.
const EXPECTED_PRIMARY_LABELS = [
  "Dashboard",
  "Missions",
  "Projects",
  "Agents",
  "Org",
  "Runs",
  "Approvals",
  "Knowledge",
  "Agent Builder",
  "Admin",
];

describe("EAOS primary nav (LET-503/LET-506)", () => {
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

describe("EAOS nav groups (LET-506 Multica adaptation)", () => {
  it("defines Personal → Workspace → Configure in that order", () => {
    expect(EAOS_NAV_GROUPS.map((group) => group.id)).toEqual([
      "personal",
      "workspace",
      "configure",
    ]);
  });

  it("leaves the Personal section unlabeled and labels Workspace + Configure", () => {
    const personal = EAOS_NAV_GROUPS.find((group) => group.id === "personal");
    expect(personal?.label).toBeNull();
    expect(EAOS_NAV_GROUPS.find((group) => group.id === "workspace")?.label).toBe("Workspace");
    expect(EAOS_NAV_GROUPS.find((group) => group.id === "configure")?.label).toBe("Configure");
  });

  it("assigns Dashboard to Personal, work surfaces to Workspace, builder/admin to Configure", () => {
    const byId = new Map(EAOS_PRIMARY_NAV.map((zone) => [zone.id, zone] as const));
    expect(byId.get("command-center")?.group).toBe("personal");
    expect(byId.get("missions")?.group).toBe("workspace");
    expect(byId.get("projects")?.group).toBe("workspace");
    expect(byId.get("agents")?.group).toBe("workspace");
    expect(byId.get("org")?.group).toBe("workspace");
    expect(byId.get("runs")?.group).toBe("workspace");
    expect(byId.get("approvals")?.group).toBe("workspace");
    expect(byId.get("knowledge")?.group).toBe("workspace");
    expect(byId.get("blueprints")?.group).toBe("configure");
    expect(byId.get("admin")?.group).toBe("configure");
  });
});
