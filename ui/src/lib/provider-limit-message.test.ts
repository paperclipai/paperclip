import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProviderLimitMessage, providerLimitMessageResetAt } from "./provider-limit-message";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("provider limit messages", () => {
  const resetAt = "2099-11-18T20:17:34.353Z";
  const message = `The provider usage limit for this agent is expected to reset at ${resetAt} (no reset time was reported, so Paperclip waits one hour). Paperclip will start this work then.`;

  it.each([
    { zone: "America/Los_Angeles", date: "Nov 18, 2099, 12:17 PM PST" },
    { zone: "Asia/Kolkata", date: "Nov 19, 2099, 1:47 AM GMT+5:30" },
    { zone: "Pacific/Auckland", date: "Nov 19, 2099, 9:17 AM GMT+13" },
  ])("uses the viewer's current timezone: $zone", ({ zone, date }) => {
    vi.stubEnv("TZ", zone);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-11-18T19:33:34.353Z"));
    expect(formatProviderLimitMessage(message)).toBe(`The provider usage limit for this agent is expected to reset in 44 minutes (${date}) (no reset time was reported, so Paperclip waits one hour). Paperclip will start this work then.`);
  });

  it.each([
    { now: "2099-11-18T19:17:34.353Z", relative: "in 1 hour" },
    { now: "2099-11-18T18:17:34.353Z", relative: "in 2 hours" },
    { now: "2099-11-18T20:17:33.353Z", relative: "in 1 second" },
    { now: "2099-11-18T20:22:34.353Z", relative: "5 minutes ago" },
  ])("computes relative time when viewed: $relative", ({ now, relative }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    expect(formatProviderLimitMessage(message)).toContain(`reset ${relative} (`);
  });

  it("formats lifecycle events and scheduled retry actions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-11-18T19:17:34.353Z"));
    for (const text of [
      `Waiting for the provider usage limit to reset at ${resetAt} before starting work`,
      `The provider usage limit resets at ${resetAt}; this wake could not schedule its retry and released the task`,
      `Waiting for the agent's provider usage limit to reset; the work starts at ${resetAt}.`,
      `This agent's provider usage limit has no reported reset time. Work is held; a retry can recheck availability after ${resetAt}; the limit may still apply then.`,
      `Waiting to recheck the provider usage limit after ${resetAt} before starting work`,
      `Paperclip will recheck the agent's provider usage limit at ${resetAt} before starting work.`,
    ]) {
      expect(formatProviderLimitMessage(text)).toContain("in 1 hour (");
      expect(formatProviderLimitMessage(text)).not.toContain(resetAt);
      expect(providerLimitMessageResetAt(text)).toBe(Date.parse(resetAt));
    }
  });

  it("uses daylight saving time at the reset date", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-07-18T19:33:00Z"));
    expect(formatProviderLimitMessage("The provider usage limit resets at 2099-07-18T20:17:00Z."))
      .toBe("The provider usage limit resets in 44 minutes (Jul 18, 2099, 1:17 PM PDT).");
  });

  it("leaves unrelated messages and invalid reset timestamps intact", () => {
    for (const text of [
      `The task starts at ${resetAt}.`,
      `The provider usage limit was observed at ${resetAt}.`,
      "The provider usage limit resets at an unknown time.",
      "The provider usage limit resets at 2099-99-99T99:99:99.999Z.",
      "",
    ]) expect(formatProviderLimitMessage(text)).toBe(text);
  });
});
