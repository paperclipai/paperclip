import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const KEY_FILE_ENV = "PAPERCLIP_HTTP_RUN_ATTESTATION_KEY_FILE";
const TOKEN_TTL_SECONDS = 120;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RUN_ATTESTATION_HEADER = "x-paperclip-run-attestation";

export interface HttpRunAttestationInput {
  url: string;
  agentId: string;
  companyId: string;
  runId: string;
  issueId: string;
}

function privateKeyFromEnvironment() {
  const path = process.env[KEY_FILE_ENV];
  if (!path) throw new Error(`${KEY_FILE_ENV} is required for HTTP run attestation`);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw new Error("HTTP run attestation requires safe nonblocking file opening support");
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("HTTP run attestation key must be a private regular file");
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > MAX_KEY_FILE_BYTES || (file.mode & 0o077) !== 0) {
      throw new Error("HTTP run attestation key must be a private regular file");
    }
    if (process.getuid && file.uid !== process.getuid()) {
      throw new Error("HTTP run attestation key must be owned by the Paperclip process user");
    }
    const key = createPrivateKey(readFileSync(fd));
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("HTTP run attestation key must use Ed25519");
    }
    return key;
  } finally {
    closeSync(fd);
  }
}

export function validateHttpRunAttestationKey(): void {
  privateKeyFromEnvironment();
}

export function createHttpRunAttestation(input: HttpRunAttestationInput): string {
  const endpoint = new URL(input.url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("HTTP run attestation requires an HTTPS endpoint without credentials or fragment");
  }
  if (![input.agentId, input.companyId, input.runId, input.issueId].every((value) => UUID.test(value))) {
    throw new Error("HTTP run attestation requires exact agent, company, run, and issue UUIDs");
  }
  const key = privateKeyFromEnvironment();
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(publicKey).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "paperclip-http-run+jwt", kid };
  const claims = {
    iss: "paperclip-http-run",
    aud: endpoint.href,
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: "http",
    run_id: input.runId,
    issue_id: input.issueId,
    iat: now,
    nbf: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature = sign(null, Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}
