import forge from "node-forge";

/**
 * Per-session ephemeral CA used by the credential broker to forge TLS
 * leaf certs for upstream hostnames during MITM.
 *
 * Key facts:
 *   - One CA per session (per agent run).
 *   - RSA-2048 — node-forge's PKI module is RSA-focused; ECDSA support
 *     would require a heavier dep tree. RSA-2048 is well above the
 *     recommended floor for ephemeral certs.
 *   - CA validity = caller's `ttlSeconds` (typically minutes), capped
 *     to a hard ceiling so a leaked CA can't outlive its session by
 *     much even if revocation fails.
 *   - CA cert and key never leave the broker process — only the CA
 *     PEM is exported to the agent for trust-anchor mounting.
 *   - Leaves are signed on demand for each (session, hostname) pair
 *     with a 10-minute validity, cached by host inside the session.
 */

/** Hard cap on CA validity regardless of caller's TTL. */
const MAX_CA_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_LEAF_TTL_SECONDS = 10 * 60;

export interface SignedLeaf {
  /** PEM-encoded private key. */
  keyPem: string;
  /** PEM-encoded leaf cert chained to the session CA. */
  certPem: string;
}

export interface SessionCa {
  /** PEM-encoded CA cert; the agent's runtime must trust this anchor. */
  readonly caPem: string;
  /** Sign (or return cached) leaf for the given hostname. */
  signLeaf(hostname: string): SignedLeaf;
  /** Number of unique hostnames the session has signed leaves for. */
  signedHostnameCount(): number;
}

export interface CreateSessionCaInput {
  /** Validity hint; clamped to [60, MAX_CA_TTL_SECONDS]. */
  ttlSeconds?: number;
  /** Override for the leaf cert validity, mostly for tests. */
  leafTtlSeconds?: number;
}

/** Validate that a host is a syntactically plausible TLS SNI / dnsName. */
function isPlausibleHostname(host: string): boolean {
  // Strip trailing dot if any.
  const h = host.replace(/\.$/, "");
  if (h.length === 0 || h.length > 253) return false;
  // RFC 1123: labels of 1-63 chars from [A-Za-z0-9-], no leading/trailing hyphen.
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    h,
  );
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return MAX_CA_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60) return 60;
  return Math.min(MAX_CA_TTL_SECONDS, Math.floor(ttlSeconds));
}

function randomSerial(): string {
  // node-forge wants a hex-encoded serial number; 16 bytes is plenty.
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

export function createSessionCa(input: CreateSessionCaInput = {}): SessionCa {
  const ttl = clampTtl(input.ttlSeconds);
  const leafTtl = input.leafTtlSeconds ?? DEFAULT_LEAF_TTL_SECONDS;

  // 1. Generate the CA keypair.
  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });

  // 2. Self-sign the CA cert.
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = randomSerial();
  const now = new Date();
  caCert.validity.notBefore = new Date(now.getTime() - 60 * 1000); // 1 min clock skew tolerance
  caCert.validity.notAfter = new Date(now.getTime() + ttl * 1000);
  const caSubject = [
    { name: "commonName", value: "Paperclip Credential Broker CA (ephemeral)" },
    { name: "organizationName", value: "Paperclip" },
  ];
  caCert.setSubject(caSubject);
  caCert.setIssuer(caSubject);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const caPem = forge.pki.certificateToPem(caCert);

  // 3. Per-host leaf cache. Entries carry `expiresAt` so stale leaves
  // are evicted and re-signed on demand — anchoring expiry to CA-creation
  // time would silently break TLS for any session over `leafTtl` seconds.
  const leafCache = new Map<string, { leaf: SignedLeaf; expiresAt: number }>();

  function signLeaf(hostname: string): SignedLeaf {
    if (!isPlausibleHostname(hostname)) {
      throw new Error(
        `credential-broker: refusing to sign leaf for invalid hostname: ${JSON.stringify(
          hostname,
        )}`,
      );
    }
    const signingNow = new Date();
    const cached = leafCache.get(hostname);
    // Keep at least 60s of remaining validity to avoid handing out a cert
    // that will expire mid-session.
    if (cached && cached.expiresAt - signingNow.getTime() > 60_000) {
      return cached.leaf;
    }

    const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const leafCert = forge.pki.createCertificate();
    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = randomSerial();
    leafCert.validity.notBefore = new Date(signingNow.getTime() - 60 * 1000);
    leafCert.validity.notAfter = new Date(signingNow.getTime() + leafTtl * 1000);
    leafCert.setSubject([
      { name: "commonName", value: hostname },
      { name: "organizationName", value: "Paperclip Credential Broker" },
    ]);
    leafCert.setIssuer(caCert.subject.attributes);
    leafCert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      {
        name: "extKeyUsage",
        serverAuth: true,
      },
      {
        name: "subjectAltName",
        altNames: [{ type: 2, value: hostname }], // type 2 = dNSName
      },
    ]);
    leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

    const signed: SignedLeaf = {
      keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
      certPem: forge.pki.certificateToPem(leafCert),
    };
    leafCache.set(hostname, {
      leaf: signed,
      expiresAt: signingNow.getTime() + leafTtl * 1000,
    });
    return signed;
  }

  return {
    caPem,
    signLeaf,
    signedHostnameCount: () => leafCache.size,
  };
}
