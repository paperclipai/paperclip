import { describe, expect, it } from "vitest";
import { createPublicKey, X509Certificate } from "node:crypto";

import { createSessionCa } from "./ca.js";

describe("createSessionCa", () => {
  it("produces a self-signed CA cert with cA basic constraint", () => {
    const ca = createSessionCa();
    const cert = new X509Certificate(ca.caPem);
    expect(cert.subject).toContain("Paperclip Credential Broker CA");
    expect(cert.ca).toBe(true);
  });

  it("signs a leaf cert for a valid hostname with the right SAN", () => {
    const ca = createSessionCa();
    const { certPem, keyPem } = ca.signLeaf("api.github.com");
    const leaf = new X509Certificate(certPem);
    expect(leaf.subject).toContain("api.github.com");
    expect(leaf.subjectAltName).toContain("api.github.com");
    expect(leaf.ca).toBe(false);
    // Verify the leaf is signed by the CA.
    const caCert = new X509Certificate(ca.caPem);
    expect(leaf.verify(caCert.publicKey)).toBe(true);
    // The private key parses without error.
    expect(() => createPublicKey(keyPem)).not.toThrow();
  });

  it("caches leaves per hostname (signLeaf is idempotent)", () => {
    const ca = createSessionCa();
    const a = ca.signLeaf("api.github.com");
    const b = ca.signLeaf("api.github.com");
    expect(a).toBe(b);
    expect(ca.signedHostnameCount()).toBe(1);
    ca.signLeaf("slack.com");
    expect(ca.signedHostnameCount()).toBe(2);
  });

  it("rejects invalid hostnames (no leaf generated)", () => {
    const ca = createSessionCa();
    expect(() => ca.signLeaf("")).toThrow(/invalid hostname/);
    expect(() => ca.signLeaf("not a host")).toThrow(/invalid hostname/);
    expect(() => ca.signLeaf("..")).toThrow(/invalid hostname/);
    expect(() => ca.signLeaf("a".repeat(254))).toThrow(/invalid hostname/);
  });

  it("clamps ttlSeconds into [60, 24h]", () => {
    const tiny = createSessionCa({ ttlSeconds: 1 });
    const certTiny = new X509Certificate(tiny.caPem);
    const tinyValidityMs =
      new Date(certTiny.validTo).getTime() -
      new Date(certTiny.validFrom).getTime();
    // Min CA validity is 60s + the 60s clock-skew lead-in.
    expect(tinyValidityMs).toBeGreaterThanOrEqual(60 * 1000);

    const huge = createSessionCa({ ttlSeconds: 30 * 24 * 60 * 60 });
    const certHuge = new X509Certificate(huge.caPem);
    const hugeValidityMs =
      new Date(certHuge.validTo).getTime() -
      new Date(certHuge.validFrom).getTime();
    // Max CA validity is 24h + the 60s clock-skew lead-in (so well under 25h).
    expect(hugeValidityMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("two sessions produce distinct CAs", () => {
    const a = createSessionCa();
    const b = createSessionCa();
    expect(a.caPem).not.toBe(b.caPem);
  });

  it("evicts and re-signs cached leaves whose validity has lapsed", async () => {
    // Tiny leaf TTL so the cached entry expires before the second
    // signLeaf call returns. Anchoring the leaf's validity to CA-creation
    // time (instead of signing time) would silently hand back the same
    // already-expired cert; this regression test fails in that case.
    const ca = createSessionCa({ leafTtlSeconds: 1 });
    const first = ca.signLeaf("api.github.com");
    await new Promise((r) => setTimeout(r, 1100));
    const second = ca.signLeaf("api.github.com");
    expect(second.certPem).not.toBe(first.certPem);
    const leaf = new X509Certificate(second.certPem);
    // The freshly-signed leaf's notAfter must be in the future.
    expect(new Date(leaf.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
