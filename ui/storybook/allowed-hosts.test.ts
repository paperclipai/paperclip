import { describe, expect, it } from "vitest";
import { storybookAllowedHosts } from "./allowed-hosts";

describe("Storybook hostname validation", () => {
  it("allows the machine's LAN and mDNS names without opening arbitrary domains", () => {
    expect(storybookAllowedHosts("Goldie")).toEqual(["localhost", "goldie", "goldie.local"]);
    expect(storybookAllowedHosts("goldie.local")).toEqual(["localhost", "goldie.local", "goldie"]);
  });

  it("retains a machine's qualified name and exact additional aliases", () => {
    expect(storybookAllowedHosts("goldie.office.example", " preview.tail123.ts.net, GOLDIE.LOCAL.\npreview.internal ")).toEqual([
      "localhost", "goldie.office.example", "goldie", "goldie.local", "preview.tail123.ts.net", "preview.internal",
    ]);
  });

  it("deduplicates aliases and ignores empty separators", () => {
    expect(storybookAllowedHosts("goldie", ",, goldie, localhost, ")).toEqual(["localhost", "goldie", "goldie.local"]);
  });

  it.each(["*", "*.example.com", ".example.com", ".local", "https://example.com", "example.com:6006", "example.com/path", "user@example.com", "example.com?query", "foo..bar", "-", "a".repeat(64), Array(5).fill("a".repeat(63)).join(".")])(
    "rejects unsafe or malformed additional host %s", (host) => {
      expect(() => storybookAllowedHosts("goldie", host)).toThrow("requires exact hostnames");
    },
  );

  it.each(["", ".local", "*.local"])("never broadens the allowlist for an invalid machine name %s", (host) => {
    expect(() => storybookAllowedHosts(host)).toThrow("requires exact hostnames");
  });
});
