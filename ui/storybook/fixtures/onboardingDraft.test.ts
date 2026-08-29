// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { ONBOARDING_STORAGE_KEY } from "@/components/OnboardingWizard";
import {
  STORYBOOK_AGENT_ID,
  STORYBOOK_COMPANY_ID,
  clearOnboardingDraft,
  readOnboardingDraft,
  seedOnboardingDraft,
} from "./onboardingDraft";

afterEach(() => {
  window.localStorage.clear();
});

describe("storybook onboarding draft", () => {
  // The leak this exists to stop: `localStorage` is per-origin and shared by
  // every story in a session, so a seeded draft left behind makes the *next*
  // story restore a saved step instead of the one it asked for. The reviewer
  // then sees a screen they did not click on, which reads as a wizard bug.
  it("leaves nothing behind once cleared", () => {
    seedOnboardingDraft(5);
    expect(readOnboardingDraft()).not.toBeNull();

    clearOnboardingDraft();
    expect(readOnboardingDraft()).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("writes the step the story asked for", () => {
    for (const step of [3, 4, 5] as const) {
      seedOnboardingDraft(step);
      expect(readOnboardingDraft()?.step).toBe(step);
    }
  });

  // `createdAgentId` is what `launchStateIncomplete` checks. Filling it in
  // before the hire would paint over the guard step 5 is supposed to show when
  // it is reached without an agent, so the earlier steps must leave it empty.
  it("only claims an agent exists from the review step onward", () => {
    seedOnboardingDraft(3);
    expect(readOnboardingDraft()?.createdAgentId).toBe("");

    seedOnboardingDraft(4);
    expect(readOnboardingDraft()?.createdAgentId).toBe("");

    seedOnboardingDraft(5);
    expect(readOnboardingDraft()?.createdAgentId).toBe(STORYBOOK_AGENT_ID);
  });

  // `restoreOnboardingState` treats restoring as an authorization decision and
  // throws the whole blob away when the saved company is not one the account
  // owns. Seeding a company the fixtures do not report would silently restore
  // nothing, and every story would quietly fall back to its `initialStep`.
  it("names the company the fixtures report as owned", () => {
    seedOnboardingDraft(5);
    expect(readOnboardingDraft()?.createdCompanyId).toBe(STORYBOOK_COMPANY_ID);
  });

  it("survives a malformed value without throwing", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{not json");
    expect(readOnboardingDraft()).toBeNull();
  });
});
