import { existsSync, readFileSync, statSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeBrokerSessionForRuntime } from "./credential-broker-runtime-env.js";

describe("materializeBrokerSessionForRuntime", () => {
  const previousNoProxy = process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA;
  beforeEach(() => {
    delete process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA;
  });
  afterEach(() => {
    if (previousNoProxy === undefined) {
      delete process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA;
    } else {
      process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA = previousNoProxy;
    }
  });

  it("writes the CA to a per-session tmpdir with restrictive mode and returns the path", () => {
    const out = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:54321",
      caCertPem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n",
      sessionToken: "session-1",
    });
    expect(existsSync(out.caPath)).toBe(true);
    expect(readFileSync(out.caPath, "utf8")).toContain("BEGIN CERTIFICATE");
    const mode = statSync(out.caPath).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no read for group/other
  });

  it("populates the full CA-trust env-var union", () => {
    const out = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:54321",
      caCertPem: "X",
      sessionToken: "session-2",
    });
    expect(out.env.HTTPS_PROXY).toBe("http://127.0.0.1:54321");
    expect(out.env.HTTP_PROXY).toBe("http://127.0.0.1:54321");
    expect(out.env.https_proxy).toBe("http://127.0.0.1:54321");
    expect(out.env.http_proxy).toBe("http://127.0.0.1:54321");
    expect(out.env.SSL_CERT_FILE).toBe(out.caPath);
    expect(out.env.NODE_EXTRA_CA_CERTS).toBe(out.caPath);
    expect(out.env.REQUESTS_CA_BUNDLE).toBe(out.caPath);
    expect(out.env.CURL_CA_BUNDLE).toBe(out.caPath);
    expect(out.env.GIT_SSL_CAINFO).toBe(out.caPath);
    expect(out.env.DENO_CERT).toBe(out.caPath);
  });

  it("includes 127.0.0.1 and localhost in NO_PROXY by default", () => {
    const out = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:0",
      caCertPem: "X",
      sessionToken: "s",
    });
    expect(out.env.NO_PROXY).toContain("127.0.0.1");
    expect(out.env.NO_PROXY).toContain("localhost");
  });

  it("appends PAPERCLIP_BROKER_NO_PROXY_EXTRA when set", () => {
    process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA =
      "api.internal.acme,.svc.cluster.local";
    const out = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:0",
      caCertPem: "X",
      sessionToken: "s",
    });
    expect(out.env.NO_PROXY).toContain("api.internal.acme");
    expect(out.env.NO_PROXY).toContain(".svc.cluster.local");
    expect(out.env.NO_PROXY).toContain("127.0.0.1");
  });

  it("two sessions produce distinct paths", () => {
    const a = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:0",
      caCertPem: "X",
      sessionToken: "s1",
    });
    const b = materializeBrokerSessionForRuntime({
      proxyUrl: "http://127.0.0.1:0",
      caCertPem: "X",
      sessionToken: "s2",
    });
    expect(a.caPath).not.toBe(b.caPath);
  });
});
