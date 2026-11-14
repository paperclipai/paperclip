import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalOperatorKey, verifyLocalOperatorSignInLink } from "@paperclipai/shared/local-operator-credential";
import { buildLocalBoardSignInUrl } from "../commands/open.js";

describe("paperclipai open", () => {
  it("builds a sign-in link the local server accepts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-open-"));
    try {
      const keyPath = path.join(dir, "local-operator.key");
      const url = new URL(buildLocalBoardSignInUrl("http://localhost:3100", keyPath));
      expect(url.origin).toBe("http://localhost:3100");
      expect(url.pathname).toBe("/api/local-operator/sign-in");
      const link = { nonce: url.searchParams.get("n"), expiresAt: url.searchParams.get("e"), signature: url.searchParams.get("s") };
      expect(verifyLocalOperatorSignInLink(readLocalOperatorKey(keyPath)!, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to sign in to a Paperclip that is not on this computer", () => {
    expect(() => buildLocalBoardSignInUrl("https://paperclip.example.com", "/nonexistent/key")).toThrow(/not local/);
  });
});
