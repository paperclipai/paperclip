// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { ONBOARDING_STORAGE_KEY } from "@/components/OnboardingWizard";
import {
  ONBOARDING_ARC_ENTRY_STEP,
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
    seedOnboardingDraft();
    expect(readOnboardingDraft()).not.toBeNull();

    clearOnboardingDraft();
    expect(readOnboardingDraft()).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  // The wizard captures `entryStep` from this draft once, at mount, and offers
  // Back only while `currentStep > entryStep`. Seeding a later step is therefore
  // not a shortcut to it — it is a step that can never show its Back button.
  it("enters the arc at its first step, so later steps can be walked into", () => {
    seedOnboardingDraft();
    expect(readOnboardingDraft()?.step).toBe(ONBOARDING_ARC_ENTRY_STEP);
  });

  // `createdAgentId` is what `launchStateIncomplete` checks. Filling it in
  // before the hire would paint over the guard step 5 is supposed to show when
  // it is reached without an agent.
  it("does not claim an agent exists before the hire", () => {
    seedOnboardingDraft();
    expect(readOnboardingDraft()?.createdAgentId).toBe("");
  });

  // The label, not the type, was seeded here once. Nothing failed loudly: the
  // connect step fell back to a real adapter, and the mismatch would only have
  // surfaced as a hire posting a type the server does not know.
  it("names the adapter by its type", () => {
    seedOnboardingDraft();
    expect(readOnboardingDraft()?.adapterType).toBe("claude_local");
  });

  // `restoreOnboardingState` treats restoring as an authorization decision and
  // throws the whole blob away when the saved company is not one the account
  // owns. Seeding a company the fixtures do not report would silently restore
  // nothing, and every story would quietly fall back to its `initialStep`.
  it("names the company the fixtures report as owned", () => {
    seedOnboardingDraft();
    expect(readOnboardingDraft()?.createdCompanyId).toBe(STORYBOOK_COMPANY_ID);
  });

  it("survives a malformed value without throwing", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{not json");
    expect(readOnboardingDraft()).toBeNull();
  });
});
