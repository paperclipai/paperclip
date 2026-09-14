import { describe, expect, it } from "vitest";
import { resolveArchivedCompanyBounce, shouldSyncCompanySelectionFromRoute } from "./company-selection";

describe("shouldSyncCompanySelectionFromRoute", () => {
  it("does not resync when selection already matches the route", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "pap",
      }),
    ).toBe(false);
  });

  it("defers route sync while a manual company switch is in flight", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "manual",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(false);
  });

  it("syncs back to the route company for non-manual mismatches", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(true);
  });
});

describe("resolveArchivedCompanyBounce", () => {
  const archived = { id: "old", name: "Old Co", issuePrefix: "OLD", status: "archived" };
  const active = { id: "pap", name: "Paperclip", issuePrefix: "PAP", status: "active" };
  const other = { id: "ret", name: "Retail", issuePrefix: "RET", status: "active" };

  it("bounces a cold arrival on an archived company's URL to the active selection", () => {
    expect(
      resolveArchivedCompanyBounce({
        matchedCompany: archived,
        selectedCompanyId: "pap",
        companies: [archived, active, other],
      }),
    ).toEqual(active);
  });

  it("bounces to the first active company when nothing is selected", () => {
    expect(
      resolveArchivedCompanyBounce({
        matchedCompany: archived,
        selectedCompanyId: null,
        companies: [archived, other],
      }),
    ).toEqual(other);
  });

  it("does not bounce a deliberate visit where the archived company is already selected", () => {
    expect(
      resolveArchivedCompanyBounce({
        matchedCompany: archived,
        selectedCompanyId: "old",
        companies: [archived, active],
      }),
    ).toBeNull();
  });

  it("does not bounce active companies or when every company is archived", () => {
    expect(
      resolveArchivedCompanyBounce({
        matchedCompany: active,
        selectedCompanyId: null,
        companies: [archived, active],
      }),
    ).toBeNull();
    expect(
      resolveArchivedCompanyBounce({
        matchedCompany: archived,
        selectedCompanyId: null,
        companies: [archived],
      }),
    ).toBeNull();
  });
});
