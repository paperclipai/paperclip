import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { requireLiveCodexHome } from "./live-codex-home.js";

const temporaryHomes: string[] = [];

function codexHome(auth: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-live-codex-home-"));
  temporaryHomes.push(home);
  fs.writeFileSync(path.join(home, "auth.json"), `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("requireLiveCodexHome", () => {
  it("rejects an unset CODEX_HOME with a named error", () => {
    expect(() => requireLiveCodexHome(undefined)).toThrowError(/live_codex_home_missing/);
  });

  it("rejects the unpaid-suite placeholder credential with a named error", () => {
    const home = codexHome({ OPENAI_API_KEY: "sk-vitest" });
    expect(() => requireLiveCodexHome(home)).toThrowError(
      /live_codex_placeholder_credential/,
    );
  });

  it("accepts a readable non-placeholder credential home", () => {
    const home = codexHome({ tokens: { access_token: "test-real-token-shape" } });
    expect(requireLiveCodexHome(home)).toBe(home);
  });
});
