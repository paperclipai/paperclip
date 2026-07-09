// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getReadItemsStorageKey,
  getDismissedAlertsStorageKey,
  loadReadInboxItems,
  saveReadInboxItems,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
} from "./inbox";

const COMPANY_A = "company-aaaa";
const COMPANY_B = "company-bbbb";

describe("inbox read/dismiss state is scoped per company", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("builds distinct storage keys per company and none without a company", () => {
    expect(getReadItemsStorageKey(COMPANY_A)).toBe(`paperclip:inbox:read-items:${COMPANY_A}`);
    expect(getReadItemsStorageKey(COMPANY_B)).toBe(`paperclip:inbox:read-items:${COMPANY_B}`);
    expect(getReadItemsStorageKey(COMPANY_A)).not.toBe(getReadItemsStorageKey(COMPANY_B));
    expect(getReadItemsStorageKey(null)).toBeNull();
    expect(getReadItemsStorageKey(undefined)).toBeNull();
    expect(getDismissedAlertsStorageKey(null)).toBeNull();
  });

  it("does not bleed read items across workspaces", () => {
    saveReadInboxItems(COMPANY_A, new Set(["run:1", "approval:2"]));

    // Company B starts clean even though Company A has read items.
    expect(loadReadInboxItems(COMPANY_B).size).toBe(0);
    // Company A retains its own state.
    expect([...loadReadInboxItems(COMPANY_A)].sort()).toEqual(["approval:2", "run:1"]);

    // Writing to B leaves A untouched.
    saveReadInboxItems(COMPANY_B, new Set(["run:9"]));
    expect([...loadReadInboxItems(COMPANY_A)].sort()).toEqual(["approval:2", "run:1"]);
    expect([...loadReadInboxItems(COMPANY_B)]).toEqual(["run:9"]);
  });

  it("does not bleed dismissed alerts across workspaces", () => {
    saveDismissedInboxAlerts(COMPANY_A, new Set(["alert:budget"]));
    expect(loadDismissedInboxAlerts(COMPANY_B).size).toBe(0);
    expect([...loadDismissedInboxAlerts(COMPANY_A)]).toEqual(["alert:budget"]);
  });

  it("is a no-op without a company id (never throws, never persists globally)", () => {
    expect(() => saveReadInboxItems(null, new Set(["run:1"]))).not.toThrow();
    expect(loadReadInboxItems(null).size).toBe(0);
    // Nothing persisted under the legacy global (unscoped) key.
    expect(localStorage.getItem("paperclip:inbox:read-items")).toBeNull();
  });
});
