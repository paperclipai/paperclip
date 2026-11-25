import { afterEach, describe, expect, it, vi } from "vitest";
import { aiSignInRemovalNotice, connectionRemovalToast, GOOGLE_THIRD_PARTY_ACCESS_URL, googleAccessRemovalNotice, googleAccessRetrySummary } from "./googleAccessRemoval";

describe("googleAccessRemovalNotice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says nothing for connections that are not Paperclip-managed Google", () => {
    expect(googleAccessRemovalNotice(undefined)).toBeNull();
    expect(googleAccessRemovalNotice(null)).toBeNull();
  });

  it("says access was ended at Google", () => {
    expect(googleAccessRemovalNotice({ provider: "google", result: "ended", outcomes: ["revoked"] })).toEqual({
      tone: "success",
      body: "Paperclip's access to this Google account was also ended at Google.",
    });
  });

  it("says other connections keep Google access", () => {
    expect(googleAccessRemovalNotice({ provider: "google", result: "other_connections_remain", outcomes: ["other_connections_remain"] })).toEqual({
      tone: "success",
      body: "Other Paperclip connections still use this Google account, so Google keeps Paperclip's access until you remove those too.",
    });
  });

  it("offers Google's own page when access could not be ended, without showing codes", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const notice = googleAccessRemovalNotice({ provider: "google", result: "not_ended", outcomes: ["revocation_not_available"] });
    expect(notice?.tone).toBe("warn");
    expect(notice?.body).toBe("Paperclip removed the connection but couldn't end its access at Google. You can remove Paperclip from your Google account's third-party connections.");
    expect(notice?.body).not.toMatch(/revocation|broker|_/);
    notice?.action?.onClick?.();
    expect(open).toHaveBeenCalledWith(GOOGLE_THIRD_PARTY_ACCESS_URL, "_blank", "noopener,noreferrer");
    expect(GOOGLE_THIRD_PARTY_ACCESS_URL).toBe("https://myaccount.google.com/connections");
  });
  it("says Paperclip keeps trying when Google has not confirmed yet, with no action to take", () => {
    const notice = googleAccessRemovalNotice({ provider: "google", result: "retrying", outcomes: ["broker_unavailable"] });
    expect(notice).toEqual({
      tone: "info",
      body: "Google didn't confirm that Paperclip's access has ended yet. Paperclip will keep trying automatically.",
    });
    expect(notice?.body).not.toMatch(/revocation|broker|_/);
    expect(connectionRemovalToast({ title: "Connection removed", body: "Removed.", providerAccess: { provider: "google", result: "retrying", outcomes: ["provider_revocation_failed"] } }))
      .toEqual({ title: "Connection removed", body: "Removed. Google didn't confirm that Paperclip's access has ended yet. Paperclip will keep trying automatically.", tone: "info" });
  });

  it("says access was ended but asks to check when the Google account cannot be confirmed", () => {
    const notice = googleAccessRemovalNotice({ provider: "google", result: "ended_unconfirmed", outcomes: ["other_connections_remain", "revoked"] });
    expect(notice?.tone).toBe("info");
    expect(notice?.body).toBe("Paperclip's access was ended at Google. If more than one Google account was connected here, check your Google account's third-party connections to be sure.");
    expect(notice?.action?.label).toBe("Open Google account connections");
  });

  it("builds the removal toast with or without a Google outcome", () => {
    expect(connectionRemovalToast({ title: "Connection removed", body: "Removed.", providerAccess: undefined }))
      .toEqual({ title: "Connection removed", body: "Removed.", tone: "success" });
    expect(connectionRemovalToast({ title: "Connection removed", body: "Removed.", providerAccess: { provider: "google", result: "ended", outcomes: ["revoked"] } }))
      .toEqual({ title: "Connection removed", body: "Removed. Paperclip's access to this Google account was also ended at Google.", tone: "success" });
  });

  it("describes how a background retry to end Google access finished, without codes", () => {
    expect(googleAccessRetrySummary("google_access_ended", { result: "ended" })).toBe("Google confirmed that Paperclip's access to this Google account has ended");
    expect(googleAccessRetrySummary("google_access_not_ended", { result: "other_connections_remain" })).toBe("Google kept Paperclip's access because other Paperclip connections use this Google account");
    expect(googleAccessRetrySummary("google_access_not_ended", { result: "gave_up" })).toBe("Paperclip stopped trying to end its access at Google without a confirmation");
  });
});

describe("aiSignInRemovalNotice", () => {
  it("says nothing when no saved Google sign-in was involved", () => {
    expect(aiSignInRemovalNotice(undefined)).toBeNull();
    expect(aiSignInRemovalNotice(null)).toBeNull();
  });

  it("says the saved sign-in was deleted and stays valid at Google", () => {
    const notice = aiSignInRemovalNotice({ provider: "google", savedSignIn: "deleted", providerSignIn: "still_valid" });
    expect(notice?.tone).toBe("info");
    expect(notice?.body).toBe("Paperclip deleted its saved Google sign-in. The sign-in stays valid at Google until you remove it in your Google account's third-party connections. Removing it there also signs this Google account out of Antigravity everywhere.");
    expect(notice?.action?.label).toBe("Open Google account connections");
  });

  it("says a shared sign-in was kept", () => {
    expect(aiSignInRemovalNotice({ provider: "google", savedSignIn: "kept_shared", providerSignIn: "still_valid" })?.body)
      .toMatch(/^Another connection still uses this saved Google sign-in, so Paperclip kept it\./);
  });

  it("warns when the saved sign-in could not be deleted", () => {
    expect(aiSignInRemovalNotice({ provider: "google", savedSignIn: "not_deleted", providerSignIn: "still_valid" })).toEqual({
      tone: "warn",
      body: "Paperclip couldn't delete its saved Google sign-in. Disconnect again to retry.",
    });
  });

  it("adds the notice to a connection removal toast", () => {
    const toast = connectionRemovalToast({
      title: "Connection deleted", body: "Google is no longer available to agents.", providerAccess: null,
      signInRemoval: { provider: "google", savedSignIn: "not_deleted", providerSignIn: "still_valid" },
    });
    expect(toast).toMatchObject({ tone: "warn", body: "Google is no longer available to agents. Paperclip couldn't delete its saved Google sign-in. Disconnect again to retry." });
  });
});
