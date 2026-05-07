import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/verify.js";

const SECRET = "topsecret";
const BODY = '{"hello":"world"}';

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySignature(BODY, sign(SECRET, BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature('{"hello":"WORLD"}', sign(SECRET, BODY), SECRET)).toBe(false);
  });

  it("rejects when signature header is missing", () => {
    expect(verifySignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when prefix is wrong", () => {
    expect(verifySignature(BODY, "sha1=" + sign(SECRET, BODY).slice(7), SECRET)).toBe(false);
  });

  it("uses constant-time comparison", () => {
    const a = sign(SECRET, BODY);
    const b = "sha256=" + "0".repeat(64);
    expect(verifySignature(BODY, b, SECRET)).toBe(false);
    expect(verifySignature(BODY, a, SECRET)).toBe(true);
  });
});
