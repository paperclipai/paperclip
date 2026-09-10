// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProductFeedbackDiagnostics,
  normalizeFeedbackRoute,
  readProductFeedbackDiagnostics,
  recordProductFeedbackDiagnostic,
} from "./product-feedback-diagnostics";

describe("product feedback diagnostics", () => {
  beforeEach(clearProductFeedbackDiagnostics);

  it("removes query data and normalizes identifiers from routes", () => {
    expect(normalizeFeedbackRoute(
      "/LOOA/issues/LOOA-2103/runs/708db09f-1a29-4dd6-ad62-99b19b6902b4?token=secret#trace",
    )).toBe("/company/issues");
  });

  it("never preserves profile slugs or plugin catch-all segments", () => {
    expect(normalizeFeedbackRoute("/LOOA/u/jane-example")).toBe("/company/profile");
    expect(normalizeFeedbackRoute("/LOOA/u/settings")).toBe("/company/profile");
    expect(normalizeFeedbackRoute("/LOOA/private-plugin/projects/settings")).toBe("/company/plugin");
    expect(normalizeFeedbackRoute("/company/settings/private-plugin/acme-config")).toBe(
      "/company/settings",
    );
  });

  it("keeps only five sanitized diagnostics", () => {
    for (let index = 0; index < 7; index += 1) {
      recordProductFeedbackDiagnostic({
        code: `Failure ${index}: reporter@example.com`,
        component: "Issue panel <unsafe>",
        route: `/issues/${index}?email=reporter@example.com`,
        timestamp: `2026-09-01T23:00:0${index}.000Z`,
      });
    }

    const diagnostics = readProductFeedbackDiagnostics();
    expect(diagnostics).toHaveLength(5);
    expect(diagnostics[0]).toEqual({
      code: "failure_2_redacted_email",
      component: "issue_panel_unsafe",
      routeTemplate: "/company/issues",
      timestamp: "2026-09-01T23:00:02.000Z",
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("reporter@example.com");
    expect(serialized).not.toContain("reporter_example.com");
  });
});
