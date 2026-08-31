import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET,
  resolveAcpxCodexManagedCredentialEnvironment,
} from "./acpx-managed-credential.js";

describe("ACPX managed Codex credential environment", () => {
  it("reads a bounded managed auth document without exposing its path", () => {
    const home = mkdtempSync(join(tmpdir(), "paperclip-acpx-managed-auth-"));
    mkdirSync(join(home, ".codex"));
    const auth = JSON.stringify({ tokens: { access_token: "managed-canary" } });
    writeFileSync(join(home, ".codex", "auth.json"), auth, { mode: 0o600 });

    expect(resolveAcpxCodexManagedCredentialEnvironment({}, { HOME: home })).toEqual({
      [PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET]: auth,
    });
  });

  it("prefers an API key and rejects malformed inline credential JSON", () => {
    expect(resolveAcpxCodexManagedCredentialEnvironment(
      { OPENAI_API_KEY: "configured" },
      { HOME: "/missing" },
    )).toEqual({});
    expect(resolveAcpxCodexManagedCredentialEnvironment(
      { [PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET]: "not-json" },
      { HOME: "/missing" },
    )).toEqual({});
  });
});
