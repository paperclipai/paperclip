import { describe, expect, it } from "vitest";
import {
  acpxCredentialFileSourcePath,
  assertAcpxCredentialFileAdmissible,
  supportsAcpxCredentialFile,
  validateCodexAuthDocument,
  validateGrokAuthDocument,
} from "./credential-file.js";

const bytes = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

describe("ACPX host credential files", () => {
  it("reads the path from the environment and treats an empty value as unset", () => {
    expect(acpxCredentialFileSourcePath({ PAPERCLIP_ACPX_AUTH_JSON_FILE: "/host/auth.json" })).toBe("/host/auth.json");
    expect(acpxCredentialFileSourcePath({ PAPERCLIP_ACPX_AUTH_JSON_FILE: "" })).toBeUndefined();
    expect(acpxCredentialFileSourcePath(undefined)).toBeUndefined();
  });

  it("is limited to agents whose login is one auth.json document", () => {
    expect(supportsAcpxCredentialFile("codex")).toBe(true);
    expect(supportsAcpxCredentialFile("grok")).toBe(true);
    for (const agent of ["claude", "pi", "cursor", "copilot", "kimi", "antigravity"] as const) {
      expect(supportsAcpxCredentialFile(agent)).toBe(false);
    }
  });

  it("rejects a host credential file for other agents or with another credential source", () => {
    const file = { PAPERCLIP_ACPX_AUTH_JSON_FILE: "/host/auth.json" };
    expect(assertAcpxCredentialFileAdmissible({}, "claude")).toBeUndefined();
    expect(assertAcpxCredentialFileAdmissible(file, "codex")).toBe("/host/auth.json");
    expect(assertAcpxCredentialFileAdmissible({ ...file, XAI_API_KEY: "other-agent" }, "codex")).toBe("/host/auth.json");
    expect(() => assertAcpxCredentialFileAdmissible(file, "claude")).toThrow("Codex or Grok ACPX profile");
    for (const [agent, name] of [
      ["codex", "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET"], ["codex", "OPENAI_API_KEY"], ["codex", "CODEX_API_KEY"],
      ["grok", "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"], ["grok", "XAI_API_KEY"],
    ] as const) {
      expect(() => assertAcpxCredentialFileAdmissible({ ...file, [name]: "value" }, agent)).toThrow("ambiguous");
    }
  });

  it("accepts Codex subscription and API-key documents only", () => {
    expect(() => validateCodexAuthDocument(bytes({ tokens: { account_id: "account-1", refresh_token: "refresh" } }))).not.toThrow();
    expect(() => validateCodexAuthDocument(bytes({ OPENAI_API_KEY: "key" }))).not.toThrow();
    for (const value of [
      { tokens: { access_token: "no-account" } },
      { tokens: { account_id: "account-1" } },
      { tokens: { account_id: " ", access_token: "access" } },
      { OPENAI_API_KEY: " " },
      [],
      "not-json",
    ]) {
      expect(() => validateCodexAuthDocument(bytes(value))).toThrow("Codex credential is malformed");
    }
    expect(() => validateCodexAuthDocument(Buffer.from([0x7b, 0xff, 0x7d]))).toThrow("Codex credential is malformed");
  });

  it("accepts one Grok identity with a key and refresh token", () => {
    const identity = "https://accounts.x.ai::11111111-1111-4111-8111-111111111111";
    expect(() => validateGrokAuthDocument(bytes({ [identity]: { key: "key", refresh_token: "refresh" } }))).not.toThrow();
    for (const value of [
      {},
      { [identity]: { key: "key" } },
      { [identity]: { key: "key", refresh_token: "refresh" }, other: {} },
      { "issuer::not-a-uuid": { key: "key", refresh_token: "refresh" } },
      { [identity]: "key" },
      "not-json",
    ]) {
      expect(() => validateGrokAuthDocument(bytes(value))).toThrow("Grok credential is malformed");
    }
  });
});
