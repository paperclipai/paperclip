// @vitest-environment node

// LET-461 / LET-463 — Route-level regression test for the legacy Paperclip
// board sidebar leaking onto the EAOS Missions surface.
//
// The QA failure on PR #85 was specifically that "Inbox", "Issues",
// "Routines", and "Goals" labels were visible on /<prefix>/eaos/missions.
// `Sidebar` is the legacy board nav that owns those labels; `Layout` is the
// kernel chrome that mounts it around board routes. This test asserts two
// invariants that must hold together:
//
//   1. The legacy `Sidebar` source still declares the four flagged labels —
//      so any drift in the legacy nav doesn't silently weaken this fix.
//   2. The kernel `Layout`'s EAOS-route gate matches the canonical Missions
//      paths under any company prefix, and does NOT match neighboring
//      board routes — proving Layout suppresses the legacy sidebar lane on
//      `/<prefix>/eaos/missions` while preserving it on `/<prefix>/issues`.
//
// We assert against the `Sidebar` source rather than rendering the real
// component because the actual Sidebar pulls in NavLink + design-system
// chrome that explodes under jsdom (Stitches CSS parse, react-query gate,
// plugin slot mounts). The mock-based `Layout.test.tsx` covers the render
// path; this test pins the contract between the two halves of the fix.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { isEaosProductRoute } from "@/components/eaos-route";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SRC = resolve(HERE, "../components/Sidebar.tsx");

describe("Missions route — legacy board sidebar suppression", () => {
  const LEGACY_LABELS = ["Inbox", "Issues", "Routines", "Goals"] as const;

  it("legacy Sidebar source still declares the QA-flagged labels (drift guard)", () => {
    const sidebarSource = readFileSync(SIDEBAR_SRC, "utf8");
    for (const label of LEGACY_LABELS) {
      expect(
        sidebarSource.includes(`label="${label}"`),
        `legacy Sidebar must still own label="${label}" so this suppression remains load-bearing`,
      ).toBe(true);
    }
  });

  it("Layout's EAOS-route gate matches the canonical Missions paths under any prefix", () => {
    // /<prefix>/eaos and any nested zone must trigger suppression of the
    // legacy sidebar lane and breadcrumb chrome.
    expect(isEaosProductRoute("/LET/eaos")).toBe(true);
    expect(isEaosProductRoute("/LET/eaos/missions")).toBe(true);
    expect(isEaosProductRoute("/LET/eaos/approvals")).toBe(true);
    expect(isEaosProductRoute("/PAP/eaos/missions")).toBe(true);
    expect(isEaosProductRoute("/PAP/eaos/sandbox")).toBe(true);
  });

  it("Layout's EAOS-route gate does NOT match neighbouring board routes (regression guard)", () => {
    // The labels QA flagged each have their own board route. Suppression
    // must be tight around /eaos so the rest of the board still gets the
    // legacy sidebar.
    expect(isEaosProductRoute("/LET/dashboard")).toBe(false);
    expect(isEaosProductRoute("/LET/inbox")).toBe(false);
    expect(isEaosProductRoute("/LET/issues")).toBe(false);
    expect(isEaosProductRoute("/LET/routines")).toBe(false);
    expect(isEaosProductRoute("/LET/goals")).toBe(false);
    expect(isEaosProductRoute("/LET/agent-os")).toBe(false);
    expect(isEaosProductRoute("/instance/settings/general")).toBe(false);
  });
});
