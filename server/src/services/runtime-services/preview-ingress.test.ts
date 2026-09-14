import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeServicePreviewConfig } from "./preview-config.js";
import { createPreviewIngressVerifier, previewIngressPayload } from "./preview-ingress.js";

const first = generateKeyPairSync("ed25519"); const second = generateKeyPairSync("ed25519");
const publicKeys = JSON.stringify([first.publicKey, second.publicKey].map((key) => key.export({ type: "spki", format: "pem" }).toString()));
function fixture() {
  vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack"); vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-token");
  const config = runtimeServicePreviewConfig("https://vercel.app", false)!;
  const verifier = createPreviewIngressVerifier(config, publicKeys);
  const host = new URL(config.origin("11111111-1111-4111-8111-111111111111", "web")).host;
  const request = (path = "/a%2Fb?q=%2F", method = "POST", key = first.privateKey, time = String(Date.now())) => ({ method, url: path, headers: {
    host: "tenant-provider.example", "x-paperclip-preview-host": host, "x-paperclip-preview-ingress-time": time,
    "x-paperclip-preview-ingress-signature": sign(null, Buffer.from(previewIngressPayload("fixture-stack", method, path, host, time)), key).toString("base64url"),
  } } as unknown as IncomingMessage);
  return { config, verifier, host, request };
}
afterEach(() => vi.unstubAllEnvs());
describe("Cloud preview ingress proof", () => {
  it("accepts the exact edge route with either overlap key without minting viewer authority", () => {
    const { verifier, host, request } = fixture();
    expect(verifier.host(request())).toBe(host); expect(verifier.host(request("/hmr?token=app", "GET", second.privateKey))).toBe(host);
    // The result supplies only a host. The existing gateway still requires a preview session.
    expect(Object.keys(verifier).sort()).toEqual(["claims", "host"]);
  });
  it("rejects changed stack, method, raw path, host, stale timestamp, duplicate or missing proof fields", () => {
    const { verifier, request, host } = fixture();
    const alterations: Array<(req: IncomingMessage) => void> = [
      (req) => { req.method = "GET"; }, (req) => { req.url = "/a/b?q=/"; },
      (req) => { req.headers["x-paperclip-preview-host"] = host.replace(/^./, host[0] === "a" ? "b" : "a"); },
      (req) => { req.headers["x-paperclip-preview-host"] = [host, host]; },
      (req) => { delete req.headers["x-paperclip-preview-ingress-time"]; },
      (req) => { req.headers["x-paperclip-preview-ingress-signature"] += ", forged"; },
    ];
    for (const alter of alterations) { const req = request(); alter(req); expect(verifier.claims(req)).toBe(true); expect(() => verifier.host(req)).toThrow(); }
    for (const time of [Date.now() - 30_001, Date.now() + 60_000]) expect(() => verifier.host(request("/", "GET", first.privateKey, String(time)))).toThrow();
    expect(() => verifier.host(request("//attacker.test/"))).toThrow();
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "other-stack");
    const other = createPreviewIngressVerifier(runtimeServicePreviewConfig("https://vercel.app", false)!, publicKeys);
    expect(() => other.host(request())).toThrow();
  });
  it("requires signatures for direct preview traffic but keeps ordinary board requests on their own route", () => {
    const { verifier, host, config } = fixture();
    const direct = { headers: { host }, url: "/", method: "GET" } as IncomingMessage;
    expect(() => verifier.host(direct)).toThrow();
    expect(verifier.host({ ...direct, headers: { host: "fixture.paperclip.app" } } as unknown as IncomingMessage)).toBe("fixture.paperclip.app");
    const disabled = createPreviewIngressVerifier(config, undefined);
    expect(() => disabled.host({ ...direct, headers: { host, "x-paperclip-preview-host": host } } as unknown as IncomingMessage)).toThrow();
  });
  it("fails closed for malformed or non-Ed25519 configured keys", () => {
    const { config } = fixture();
    for (const value of ["invalid", "[]", '["invalid"]', '{}', '[1]', JSON.stringify(Array(3).fill(first.publicKey.export({ type: "spki", format: "pem" }).toString()))]) expect(() => createPreviewIngressVerifier(config, value)).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => createPreviewIngressVerifier(config, JSON.stringify([rsa]))).toThrow();
  });
});
