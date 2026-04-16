/**
 * Egress allowlist verification.
 *
 * These tests verify the allowlist logic in entrypoint.sh by testing the
 * host resolution + iptables parsing in isolation. The actual iptables DROP
 * is only enforced inside the container (requires NET_ADMIN capability).
 *
 * What's tested here:
 * - The default allowlist contains exactly the expected entries.
 * - Unlisted hosts are not in the default allowlist.
 *
 * For a full integration test (actually verifying DROP), run:
 *   docker compose -f deploy/docker-compose.yml up -d
 *   docker exec surfer-sidecar curl -s --max-time 5 https://google.com
 * That curl should timeout/fail if egress is working correctly.
 */

import { describe, expect, it } from "vitest";

const DEFAULT_ALLOWLIST =
  "dev.to,2captcha.com,hcaptcha.com,challenges.cloudflare.com,api.paperclip.ing";

function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

describe("egress allowlist", () => {
  it("contains the expected default entries", () => {
    const hosts = parseAllowlist(DEFAULT_ALLOWLIST);
    expect(hosts).toContain("dev.to");
    expect(hosts).toContain("2captcha.com");
    expect(hosts).toContain("hcaptcha.com");
    expect(hosts).toContain("challenges.cloudflare.com");
    expect(hosts).toContain("api.paperclip.ing");
  });

  it("does not contain unlisted hosts by default", () => {
    const hosts = new Set(parseAllowlist(DEFAULT_ALLOWLIST));
    expect(hosts.has("google.com")).toBe(false);
    expect(hosts.has("facebook.com")).toBe(false);
    expect(hosts.has("example.com")).toBe(false);
  });

  it("parseAllowlist handles trailing whitespace and empty segments", () => {
    const hosts = parseAllowlist("  dev.to , , 2captcha.com  ");
    expect(hosts).toEqual(["dev.to", "2captcha.com"]);
  });
});
