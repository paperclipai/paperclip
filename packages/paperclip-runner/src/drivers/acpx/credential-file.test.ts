import { describe, expect, it } from "vitest";
import { validateCodexAuthDocument, validateGrokAuthDocument } from "./credential-file.js";

const identity = "https://accounts.x.ai::11111111-1111-4111-8111-111111111111";
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("ACPX host credential file formats", () => {
  it.each([
    ["Codex subscription", validateCodexAuthDocument, json({ tokens: { account_id: "account-1", refresh_token: "refresh" } }), true],
    ["Codex API key", validateCodexAuthDocument, json({ OPENAI_API_KEY: "key" }), true],
    ["Codex without account", validateCodexAuthDocument, json({ tokens: { access_token: "no-account" } }), false],
    ["Codex without tokens", validateCodexAuthDocument, json({ tokens: { account_id: "account-1" } }), false],
    ["Codex blank API key", validateCodexAuthDocument, json({ OPENAI_API_KEY: " " }), false],
    ["Codex invalid UTF-8", validateCodexAuthDocument, Buffer.from([0x7b, 0xff, 0x7d]), false],
    ["Grok login", validateGrokAuthDocument, json({ [identity]: { key: "key", refresh_token: "refresh" } }), true],
    ["Grok without refresh token", validateGrokAuthDocument, json({ [identity]: { key: "key" } }), false],
    ["Grok with two identities", validateGrokAuthDocument, json({ [identity]: { key: "key", refresh_token: "refresh" }, other: {} }), false],
    ["Grok invalid identity", validateGrokAuthDocument, json({ "issuer::not-a-uuid": { key: "key", refresh_token: "refresh" } }), false],
    ["Grok not JSON", validateGrokAuthDocument, Buffer.from("not-json"), false],
  ] as const)("validates a %s document", (_name, validate, document, valid) => {
    if (valid) expect(() => validate(document)).not.toThrow();
    else expect(() => validate(document)).toThrow(/credential is malformed/);
  });
});
