import { createDecipheriv, createHmac, diffieHellman, generateKeyPairSync, createPublicKey, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubBrokerSealedTranscript, openSealedGitHubBrokerRequest, sealGitHubBrokerResponse } from "./github-broker-seal.js";

const PATH = "/runtime-tools/github/credentials";
const signatureFor = (unsigned: string) => createHmac("sha256", "signing-secret").update(unsigned).digest("base64url");
const token = ["{\"alg\":\"HS256\"}", "{\"run_id\":\"run-1\"}"].map(part => Buffer.from(part).toString("base64url")).join(".");

// Mirrors the launcher client in githubLauncherSource().
function client(overrides: { ts?: number; signature?: string; key?: string; token?: string } = {}) {
  const pair = generateKeyPairSync("x25519");
  const key = overrides.key ?? pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const ts = overrides.ts ?? Date.now();
  const nonce = randomBytes(16).toString("base64url");
  const signature = overrides.signature ?? signatureFor(token);
  const sentToken = overrides.token ?? token;
  const transcript = githubBrokerSealedTranscript({ path: PATH, token: sentToken, ts, nonce, key: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url") });
  const proof = createHmac("sha256", signature).update(transcript).digest("base64url");
  const header = Buffer.from(JSON.stringify({ v: 1, token: sentToken, ts, nonce, key, proof })).toString("base64url");
  const open = (sealed: { key: string; iv: string; data: string; tag: string }, withSignature = signature) => {
    const aad = `${transcript}\n${sealed.key}`;
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey({ key: Buffer.from(sealed.key, "base64url"), format: "der", type: "spki" }) });
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", shared, Buffer.from(withSignature), Buffer.from(aad), 32)), Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64url")), decipher.final()]).toString("utf8"));
  };
  return { header, open };
}

describe("sealed GitHub broker exchange", () => {
  it("round-trips credentials without the header carrying the signature", () => {
    const { header, open } = client();
    expect(Buffer.from(header, "base64url").toString("utf8")).not.toContain(signatureFor(token));
    const opened = openSealedGitHubBrokerRequest(header, PATH, signatureFor);
    expect(opened?.token).toBe(`${token}.${signatureFor(token)}`);
    const sealed = sealGitHubBrokerResponse(opened!, { status: "available", env: { GH_TOKEN: "secret-token" } });
    expect(JSON.stringify(sealed)).not.toContain("secret-token");
    expect(open(sealed)).toEqual({ status: "available", env: { GH_TOKEN: "secret-token" } });
  });

  it.each([
    ["a proof made without the signature", () => client({ signature: "guessed" }).header],
    ["a substituted client key", () => client({ key: generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url") }).header],
    ["a stale timestamp", () => client({ ts: Date.now() - 5 * 60_000 }).header],
    ["a signed (three-part) token", () => client({ token: `${token}.${signatureFor(token)}` }).header],
    ["garbage", () => "not-base64-json"],
  ])("rejects %s", (_case, header) => {
    expect(openSealedGitHubBrokerRequest(header(), PATH, signatureFor)).toBeNull();
  });

  it("rejects tokens the broker cannot sign and a different route", () => {
    expect(openSealedGitHubBrokerRequest(client().header, PATH, () => null)).toBeNull();
    expect(openSealedGitHubBrokerRequest(client().header, "/other", signatureFor)).toBeNull();
  });

  it("cannot be opened by a party without the signature, even with the response", () => {
    const { header, open } = client();
    const sealed = sealGitHubBrokerResponse(openSealedGitHubBrokerRequest(header, PATH, signatureFor)!, { env: { GH_TOKEN: "t" } });
    expect(() => open(sealed, "wrong-signature")).toThrow();
    expect(() => open({ ...sealed, data: Buffer.from("forged").toString("base64url") })).toThrow();
  });
});
