import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_THIRD_PARTY_ACCESS_URL, googleAccessRemovalNotice } from "./googleAccessRemoval";

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
});
