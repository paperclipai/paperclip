import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSha256, verifySendgridSignature } from "./webhook-signatures.js";

describe("verifyHmacSha256", () => {
  const SECRET = "test-secret-deadbeef";
  const BODY = Buffer.from(JSON.stringify({ event: "delivered", id: "abc" }));
  const validSig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");

  it("accepts a correct signature in bare hex form", () => {
    expect(verifyHmacSha256(BODY, validSig, SECRET)).toBe(true);
  });

  it("accepts a correct signature with sha256= prefix", () => {
    expect(verifyHmacSha256(BODY, `sha256=${validSig}`, SECRET)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const tampered = `${validSig.slice(0, -2)}00`;
    expect(verifyHmacSha256(BODY, tampered, SECRET)).toBe(false);
  });

  it("rejects when body has been modified", () => {
    const modified = Buffer.from(`${BODY.toString()} `);
    expect(verifyHmacSha256(modified, validSig, SECRET)).toBe(false);
  });

  it("rejects when secret is wrong", () => {
    expect(verifyHmacSha256(BODY, validSig, "wrong-secret")).toBe(false);
  });

  it("rejects empty / missing signature", () => {
    expect(verifyHmacSha256(BODY, "", SECRET)).toBe(false);
    expect(verifyHmacSha256(BODY, null, SECRET)).toBe(false);
    expect(verifyHmacSha256(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects empty / missing secret", () => {
    expect(verifyHmacSha256(BODY, validSig, "")).toBe(false);
  });

  it("rejects non-hex garbage without throwing", () => {
    expect(verifyHmacSha256(BODY, "not-a-hex-string!!", SECRET)).toBe(false);
    expect(verifyHmacSha256(BODY, "sha256=zzzz", SECRET)).toBe(false);
  });

  it("rejects length-mismatched signatures (no oracle)", () => {
    expect(verifyHmacSha256(BODY, "abcd", SECRET)).toBe(false);
  });
});

describe("verifySendgridSignature", () => {
  // Generate a fresh Ed25519 key pair for the test.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const publicKeyBareB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");

  const BODY = Buffer.from(JSON.stringify([{ event: "delivered" }]));
  const TIMESTAMP = "1700000000";

  function sign(ts: string, body: Buffer): string {
    const message = Buffer.concat([Buffer.from(ts, "utf8"), body]);
    return crypto.sign(null, message, privateKey).toString("base64");
  }

  it("accepts a correctly-signed payload with full PEM key", () => {
    const sig = sign(TIMESTAMP, BODY);
    expect(verifySendgridSignature(BODY, TIMESTAMP, sig, publicKeyPem)).toBe(true);
  });

  it("accepts a correctly-signed payload with bare base64 DER key (SendGrid UI form)", () => {
    const sig = sign(TIMESTAMP, BODY);
    expect(verifySendgridSignature(BODY, TIMESTAMP, sig, publicKeyBareB64)).toBe(true);
  });

  it("rejects tampered body", () => {
    const sig = sign(TIMESTAMP, BODY);
    expect(verifySendgridSignature(Buffer.from("tampered"), TIMESTAMP, sig, publicKeyPem)).toBe(false);
  });

  it("rejects tampered timestamp", () => {
    const sig = sign(TIMESTAMP, BODY);
    expect(verifySendgridSignature(BODY, "1700000001", sig, publicKeyPem)).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifySendgridSignature(BODY, "", "sig", publicKeyPem)).toBe(false);
    expect(verifySendgridSignature(BODY, TIMESTAMP, "", publicKeyPem)).toBe(false);
    expect(verifySendgridSignature(BODY, TIMESTAMP, "sig", "")).toBe(false);
  });

  it("rejects malformed key without throwing", () => {
    const sig = sign(TIMESTAMP, BODY);
    expect(verifySendgridSignature(BODY, TIMESTAMP, sig, "not-a-key")).toBe(false);
  });

  it("rejects malformed signature without throwing", () => {
    expect(verifySendgridSignature(BODY, TIMESTAMP, "!!!not-base64-but-decodes-to-junk!!!", publicKeyPem)).toBe(false);
  });
});
