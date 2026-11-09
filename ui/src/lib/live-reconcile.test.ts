import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_FREE_STALE_TIME_MS,
  applyLiveEventFreeQueryDefaults,
  isLiveReconciledQuery,
} from "./live-reconcile";
import { queryKeys } from "./queryKeys";

describe("live reconcile scope", () => {
  it("skips instance and personal preference reads", () => {
    for (const queryKey of [
      queryKeys.instance.settings,
      queryKeys.instance.experimentalSettings,
      queryKeys.instance.generalSettings,
      queryKeys.plugins.uiContributions,
      queryKeys.workspacePreferences.mine("user-1"),
      queryKeys.sidebarPreferences.companyOrder("user-1"),
      queryKeys.sidebarPreferences.projectOrder("company-1", "user-1"),
    ]) {
      expect(isLiveReconciledQuery({ queryKey }), JSON.stringify(queryKey)).toBe(false);
    }
  });

  it("keeps company data and the sign-out and reconnect checks", () => {
    for (const queryKey of [
      queryKeys.auth.session,
      queryKeys.health,
      queryKeys.companies.all,
      queryKeys.agents.list("company-1"),
      queryKeys.projects.all("company-1"),
      ["plugins", "company-1"],
      ["instance-admin"],
    ]) {
      expect(isLiveReconciledQuery({ queryKey }), JSON.stringify(queryKey)).toBe(true);
    }
  });

  it("gives event-free reads a longer stale time and leaves others on the app default", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    applyLiveEventFreeQueryDefaults(client);
    for (const queryKey of [
      queryKeys.instance.settings,
      queryKeys.instance.generalSettings,
      queryKeys.instance.experimentalSettings,
      queryKeys.plugins.uiContributions,
      queryKeys.sidebarPreferences.companyOrder("user-1"),
    ]) {
      expect(client.defaultQueryOptions({ queryKey }).staleTime, JSON.stringify(queryKey)).toBe(LIVE_EVENT_FREE_STALE_TIME_MS);
    }
    expect(client.defaultQueryOptions({ queryKey: queryKeys.workspacePreferences.mine("user-1") }).staleTime)
      .toBe(LIVE_EVENT_FREE_STALE_TIME_MS);
    expect(client.defaultQueryOptions({ queryKey: queryKeys.agents.list("company-1") }).staleTime).toBe(30_000);
  });
});
