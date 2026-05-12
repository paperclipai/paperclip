import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { AddressInfo } from "node:net";
import forge from "node-forge";

import { createSessionStore } from "../session-store.js";
import { createProxyListener, type ProxyListener } from "../proxy-listener.js";

/**
 * End-to-end test for the M2 credential broker pipeline:
 *   - stub HTTPS upstream records what it receives
 *   - proxy listener does TLS MITM with a per-session CA
 *   - client makes a CONNECT through the proxy with placeholder
 *     Authorization; upstream MUST see the real bearer
 */

function generateTestCa() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 60 * 60_000);
  const subject = [{ name: "commonName", value: "test-ca" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

function signLocalhostLeaf(ca: { keys: forge.pki.rsa.KeyPair; cert: forge.pki.Certificate }) {
  const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = "02";
  leaf.validity.notBefore = new Date(Date.now() - 60_000);
  leaf.validity.notAfter = new Date(Date.now() + 60 * 60_000);
  leaf.setSubject([{ name: "commonName", value: "localhost" }]);
  leaf.setIssuer(ca.cert.subject.attributes);
  leaf.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" }, // type 7 = iPAddress
      ],
    },
  ]);
  leaf.sign(ca.keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    certPem: forge.pki.certificateToPem(leaf),
  };
}

describe("credential-broker end-to-end", () => {
  let upstreamServer: HttpsServer | undefined;
  let upstreamPort = 0;
  let upstreamObserved: { authorization?: string; path?: string }[] = [];
  let proxy: ProxyListener | undefined;
  let testCaPem = "";

  beforeEach(async () => {
    upstreamObserved = [];
    const ca = generateTestCa();
    testCaPem = forge.pki.certificateToPem(ca.cert);
    const { keyPem, certPem } = signLocalhostLeaf(ca);

    upstreamServer = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => {
      const authHeader = req.headers.authorization;
      upstreamObserved.push({
        authorization: Array.isArray(authHeader) ? authHeader[0] : authHeader,
        path: req.url,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer!.listen(0, "127.0.0.1", () => resolve()),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstreamServer?.close(() => resolve()));
    if (proxy) await proxy.close();
  });

  it("injects the real bearer upstream; agent sees only the placeholder", async () => {
    const store = createSessionStore();
    proxy = createProxyListener({
      store,
      upstreamTlsOpts: { ca: testCaPem },
    });
    await proxy.listen({ host: "127.0.0.1", port: 0 });

    const session = store.create({
      companyId: "co-1",
      runId: "run-1",
      connectionIds: ["c-1"],
      oauthEnvBindings: [{ envVarName: "GH", connectionId: "c-1" }],
      hostRules: [
        {
          hostname: "localhost",
          connectionId: "c-1",
          header: "Authorization",
          format: "Bearer {value}",
        },
      ],
      ttlSeconds: 300,
    });
    session.setBearer("c-1", "REAL-BEARER-XYZ");

    const proxyAddress = proxy.proxyUrl().replace(/^http:\/\//, "");
    const [proxyHost, proxyPortStr] = proxyAddress.split(":");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tls = require("node:tls");

    const placeholder = session.placeholders.GH;

    // 1. Open a TCP socket to the proxy.
    const tunnel = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const s = net.connect(
        { host: proxyHost, port: Number.parseInt(proxyPortStr, 10) },
        () => resolve(s),
      );
      s.once("error", reject);
    });

    // 2. CONNECT to upstream through the proxy.
    tunnel.write(
      `CONNECT localhost:${upstreamPort} HTTP/1.1\r\n` +
        `Host: localhost:${upstreamPort}\r\n` +
        `Proxy-Authorization: Bearer ${session.sessionToken}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        tunnel.off("data", onData);
        if (!buf.startsWith("HTTP/1.1 200")) {
          reject(new Error(`bad proxy response: ${buf.slice(0, idx)}`));
        } else {
          resolve();
        }
      };
      tunnel.on("data", onData);
    });

    // 3. TLS-upgrade the tunnel to the proxy's session CA chain.
    const tlsSocket: import("node:tls").TLSSocket = await new Promise(
      (resolve, reject) => {
        const s = tls.connect({
          socket: tunnel,
          host: "localhost",
          servername: "localhost",
          ca: session.ca.caPem,
        });
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      },
    );

    // 4. Send the inner HTTP/1.1 GET with placeholder Authorization.
    tlsSocket.write(
      `GET /repos/foo/bar HTTP/1.1\r\n` +
        `Host: localhost:${upstreamPort}\r\n` +
        `Authorization: Bearer ${placeholder}\r\n` +
        `User-Agent: broker-e2e-test\r\n` +
        `Connection: close\r\n\r\n`,
    );

    // 5. Read the full HTTP response.
    const responseRaw = await new Promise<string>((resolve, reject) => {
      let buf = "";
      tlsSocket.on("data", (chunk: Buffer) => (buf += chunk.toString("utf8")));
      tlsSocket.on("end", () => resolve(buf));
      tlsSocket.on("error", reject);
    });

    const bodyStart = responseRaw.indexOf("\r\n\r\n");
    const responseBody = bodyStart === -1 ? responseRaw : responseRaw.slice(bodyStart + 4);

    // Upstream returns chunked transfer encoding; we just assert the JSON
    // body is present somewhere in the framed bytes.
    expect(responseBody).toContain(`{"ok":true}`);
    expect(upstreamObserved).toHaveLength(1);
    expect(upstreamObserved[0].path).toBe("/repos/foo/bar");
    // The upstream must receive the real bearer …
    expect(upstreamObserved[0].authorization).toBe("Bearer REAL-BEARER-XYZ");
    // … and the placeholder must NOT appear at upstream (the proxy must
    // have stripped it before injecting the real value).
    expect(upstreamObserved[0].authorization).not.toContain(placeholder);
  });

  it("rejects CONNECT to a host not in session.hostRules with 403", async () => {
    const store = createSessionStore();
    proxy = createProxyListener({
      store,
      upstreamTlsOpts: { ca: testCaPem },
    });
    await proxy.listen({ host: "127.0.0.1", port: 0 });

    const session = store.create({
      companyId: "co-1",
      runId: "run-1",
      connectionIds: ["c-1"],
      oauthEnvBindings: [],
      hostRules: [
        {
          hostname: "api.github.com",
          connectionId: "c-1",
          header: "Authorization",
          format: "Bearer {value}",
        },
      ],
      ttlSeconds: 300,
    });

    const proxyAddress = proxy.proxyUrl().replace(/^http:\/\//, "");
    const [proxyHost, proxyPortStr] = proxyAddress.split(":");

    // CONNECT to a disallowed host; should get 403.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net");
    const status = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(
        { host: proxyHost, port: Number.parseInt(proxyPortStr, 10) },
        () => {
          sock.write(
            `CONNECT evil.example.com:443 HTTP/1.1\r\n` +
              `Host: evil.example.com:443\r\n` +
              `Proxy-Authorization: Bearer ${session.sessionToken}\r\n\r\n`,
          );
        },
      );
      let buf = "";
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\r\n")) {
          resolve(buf.split("\r\n")[0]);
          sock.destroy();
        }
      });
      sock.on("error", reject);
    });

    expect(status).toContain("403");
  });

  it("rejects CONNECT with no/bad Proxy-Authorization with 407", async () => {
    const store = createSessionStore();
    proxy = createProxyListener({
      store,
      upstreamTlsOpts: { ca: testCaPem },
    });
    await proxy.listen({ host: "127.0.0.1", port: 0 });

    const proxyAddress = proxy.proxyUrl().replace(/^http:\/\//, "");
    const [proxyHost, proxyPortStr] = proxyAddress.split(":");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net");
    const status = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(
        { host: proxyHost, port: Number.parseInt(proxyPortStr, 10) },
        () => {
          sock.write(
            `CONNECT api.github.com:443 HTTP/1.1\r\n` +
              `Host: api.github.com:443\r\n\r\n`,
          );
        },
      );
      let buf = "";
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\r\n")) {
          resolve(buf.split("\r\n")[0]);
          sock.destroy();
        }
      });
      sock.on("error", reject);
    });

    expect(status).toContain("407");
  });
});
