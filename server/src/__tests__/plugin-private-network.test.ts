import { describe, expect, it } from "vitest";
import {
  assertPluginPrivateNetworkHostKey,
  buildApprovedPrivateNetworkHostSet,
  findPrivateNetworkHostDeclaration,
  getStoredPrivateNetworkHosts,
  normalizePrivateNetworkHostValue,
  requirePrivateNetworkHostDeclaration,
} from "../services/plugin-private-network.js";

describe("plugin private network host allowlist", () => {
  describe("assertPluginPrivateNetworkHostKey", () => {
    it("accepts a lowercase alphanumeric key with allowed separators", () => {
      expect(() => assertPluginPrivateNetworkHostKey("home-assistant.lan_v1")).not.toThrow();
    });

    it("rejects an uppercase or otherwise malformed key", () => {
      expect(() => assertPluginPrivateNetworkHostKey("Home-Assistant")).toThrow();
      expect(() => assertPluginPrivateNetworkHostKey("")).toThrow();
      expect(() => assertPluginPrivateNetworkHostKey("-leading-hyphen")).toThrow();
    });
  });

  describe("normalizePrivateNetworkHostValue", () => {
    it("accepts and lowercases a valid DNS hostname", () => {
      expect(normalizePrivateNetworkHostValue("HA.TieredInt.com")).toBe("ha.tieredint.com");
    });

    it("accepts a valid IPv4 literal", () => {
      expect(normalizePrivateNetworkHostValue("10.0.1.204")).toBe("10.0.1.204");
    });

    it("rejects an out-of-range IPv4 octet", () => {
      expect(() => normalizePrivateNetworkHostValue("10.0.1.999")).toThrow();
    });

    it("rejects a wildcard host", () => {
      expect(() => normalizePrivateNetworkHostValue("*.tieredint.com")).toThrow();
    });

    it("rejects a value with a scheme, path, or credentials", () => {
      expect(() => normalizePrivateNetworkHostValue("https://ha.tieredint.com")).toThrow();
      expect(() => normalizePrivateNetworkHostValue("ha.tieredint.com/api")).toThrow();
      expect(() => normalizePrivateNetworkHostValue("user@ha.tieredint.com")).toThrow();
    });

    it("rejects a value with an embedded port", () => {
      expect(() => normalizePrivateNetworkHostValue("ha.tieredint.com:8123")).toThrow();
    });

    it("rejects an empty or whitespace-only value", () => {
      expect(() => normalizePrivateNetworkHostValue("   ")).toThrow();
    });

    it("rejects an IPv4 literal with a leading-zero octet", () => {
      // The WHATWG URL parser treats a leading-zero octet as octal (e.g.
      // "010" -> decimal 8), so a stored value with leading zeros would
      // never exact-match the hostname `validateAndResolveFetchUrl` sees
      // from the actual fetch target. Reject at the source instead of
      // trying to replicate octal canonicalization here.
      expect(() => normalizePrivateNetworkHostValue("10.0.1.004")).toThrow();
      expect(() => normalizePrivateNetworkHostValue("010.0.1.4")).toThrow();
    });
  });

  describe("findPrivateNetworkHostDeclaration / requirePrivateNetworkHostDeclaration", () => {
    const declarations = [
      { hostKey: "ha", displayName: "Home Assistant" },
      { hostKey: "other", displayName: "Other host" },
    ];

    it("finds a declared host by key", () => {
      expect(findPrivateNetworkHostDeclaration(declarations, "ha")).toEqual(declarations[0]);
      expect(findPrivateNetworkHostDeclaration(declarations, "missing")).toBeNull();
    });

    it("requires the host to be declared in the manifest", () => {
      expect(() => requirePrivateNetworkHostDeclaration(declarations, "ha")).not.toThrow();
      expect(() => requirePrivateNetworkHostDeclaration(declarations, "undeclared")).toThrow();
    });
  });

  describe("getStoredPrivateNetworkHosts", () => {
    it("reads stored hosts keyed by hostKey", () => {
      const stored = getStoredPrivateNetworkHosts({
        privateNetworkHosts: {
          ha: { host: "ha.tieredint.com", updatedAt: "2026-10-07T00:00:00.000Z" },
          other: { host: "10.0.1.50" },
        },
      });
      expect(stored.ha?.host).toBe("ha.tieredint.com");
      expect(stored.other?.host).toBe("10.0.1.50");
    });

    it("returns an empty object when nothing is stored yet", () => {
      expect(getStoredPrivateNetworkHosts(null)).toEqual({});
      expect(getStoredPrivateNetworkHosts({})).toEqual({});
    });
  });

  describe("buildApprovedPrivateNetworkHostSet", () => {
    const declarations = [
      { hostKey: "ha", displayName: "Home Assistant" },
      { hostKey: "undeclared-stored", displayName: "Stale declaration" },
    ];

    it("only approves hosts that are both declared and stored", () => {
      const stored = {
        ha: { host: "ha.tieredint.com" },
        // No matching declaration for this key — must never be honored.
        leftover: { host: "evil.example.com" },
      };
      const approved = buildApprovedPrivateNetworkHostSet(declarations, stored);
      expect(approved).toEqual(new Set(["ha.tieredint.com"]));
    });

    it("approves nothing when no host has been configured yet", () => {
      expect(buildApprovedPrivateNetworkHostSet(declarations, {})).toEqual(new Set());
    });

    it("approves nothing when there are no declarations", () => {
      expect(buildApprovedPrivateNetworkHostSet(undefined, { ha: { host: "ha.tieredint.com" } })).toEqual(new Set());
    });
  });
});
