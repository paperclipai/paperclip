// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest";
import { rememberPendingInviteToken, clearPendingInviteToken, getRememberedInvitePath } from "./invite-memory";

const STORAGE_KEY = "paperclip:pending-invite-token";

describe("invite-memory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("rememberPendingInviteToken", () => {
    it("saves a trimmed token to localStorage", () => {
      rememberPendingInviteToken("  abc123  ");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("abc123");
    });

    it("skips saving for empty token", () => {
      rememberPendingInviteToken("");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("skips saving for whitespace-only token", () => {
      rememberPendingInviteToken("   ");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("replaces a previously saved token", () => {
      rememberPendingInviteToken("token1");
      rememberPendingInviteToken("token2");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("token2");
    });
  });

  describe("getRememberedInvitePath", () => {
    it("returns /invite/{token} when a token is saved", () => {
      localStorage.setItem(STORAGE_KEY, "abc123");
      expect(getRememberedInvitePath()).toBe("/invite/abc123");
    });

    it("returns null when no token is saved", () => {
      expect(getRememberedInvitePath()).toBeNull();
    });

    it("returns null when saved value is empty", () => {
      localStorage.setItem(STORAGE_KEY, "");
      expect(getRememberedInvitePath()).toBeNull();
    });

    it("returns null when saved value is only whitespace", () => {
      localStorage.setItem(STORAGE_KEY, "   ");
      expect(getRememberedInvitePath()).toBeNull();
    });
  });

  describe("clearPendingInviteToken", () => {
    it("removes the token from localStorage", () => {
      localStorage.setItem(STORAGE_KEY, "abc123");
      clearPendingInviteToken();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("removes the token when expectedToken matches", () => {
      localStorage.setItem(STORAGE_KEY, "abc123");
      clearPendingInviteToken("abc123");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("does not remove when expectedToken does not match", () => {
      localStorage.setItem(STORAGE_KEY, "abc123");
      clearPendingInviteToken("wrong-token");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("abc123");
    });

    it("trims the expectedToken before comparing", () => {
      localStorage.setItem(STORAGE_KEY, "abc123");
      clearPendingInviteToken("  abc123  ");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("is a no-op when localStorage is empty", () => {
      clearPendingInviteToken();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("end-to-end flow", () => {
    it("remember → getPath → clear roundtrip", () => {
      rememberPendingInviteToken("my-token");
      expect(getRememberedInvitePath()).toBe("/invite/my-token");
      clearPendingInviteToken("my-token");
      expect(getRememberedInvitePath()).toBeNull();
    });

    it("eager save survives a second write (idempotent)", () => {
      rememberPendingInviteToken("my-token");
      rememberPendingInviteToken("my-token");
      expect(getRememberedInvitePath()).toBe("/invite/my-token");
    });
  });
});
