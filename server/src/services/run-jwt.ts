import { createHmac, timingSafeEqual } from "node:crypto";

export interface RunJwtClaims {
  runId: string;
  agentId: string;
  companyId: string;
  jobUid: string;
  exp: number; // unix seconds
}

interface RunJwtHeader {
  alg: string;
  typ?: string;
}

export interface MintInput extends Omit<RunJwtClaims, "exp"> { ttlSeconds: number; }

export type VerifyResult =
  | { ok: true; claims: RunJwtClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export interface RunJwtService {
  mint(input: MintInput): string;
  verify(token: string): VerifyResult;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function runJwtService(secret: string): RunJwtService {
  const key = Buffer.from(secret);
  return {
    mint(input) {
      const header = { alg: "HS256", typ: "JWT" };
      const claims: RunJwtClaims = {
        runId: input.runId,
        agentId: input.agentId,
        companyId: input.companyId,
        jobUid: input.jobUid,
        exp: Math.floor(Date.now() / 1000) + input.ttlSeconds,
      };
      const headerEncoded = b64url(JSON.stringify(header));
      const claimsEncoded = b64url(JSON.stringify(claims));
      const signing = `${headerEncoded}.${claimsEncoded}`;
      const sig = createHmac("sha256", key).update(signing).digest();
      return `${signing}.${b64url(sig)}`;
    },
    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const [headerEncoded, claimsEncoded, sigEncoded] = parts;
      const expectedSig = createHmac("sha256", key).update(`${headerEncoded}.${claimsEncoded}`).digest();
      const givenSig = b64urlDecode(sigEncoded);
      if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
        return { ok: false, reason: "bad_signature" };
      }
      let header: RunJwtHeader;
      let claims: RunJwtClaims;
      try {
        header = JSON.parse(b64urlDecode(headerEncoded).toString("utf-8")) as RunJwtHeader;
        claims = JSON.parse(b64urlDecode(claimsEncoded).toString("utf-8")) as RunJwtClaims;
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) {
        return { ok: false, reason: "malformed" };
      }
      if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
      return { ok: true, claims };
    },
  };
}
