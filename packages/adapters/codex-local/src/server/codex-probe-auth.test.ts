import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexProbeAuth,
  snapshotDurableCodexProbeAuth,
} from "./codex-probe-auth.js";

function subscriptionAuth(accountId = "acct-probe"): string {
  return JSON.stringify({
    tokens: {
      account_id: accountId,
      access_token: "access-token",
      refresh_token: "refresh-token",
    },
    last_refresh: "2026-08-31T00:00:00Z",
  });
}

describe("Codex live-probe auth classification", () => {
  it("accepts only an exact API-key payload or a usable subscription identity", () => {
    expect(classifyCodexProbeAuth(Buffer.from('{"OPENAI_API_KEY":"sk-test"}')))
      .toBe("api_key");
    expect(classifyCodexProbeAuth(Buffer.from(
      '{"OPENAI_API_KEY":"sk-test","tokens":{"account_id":"mixed"}}',
    ))).toBe("unsupported");
    expect(classifyCodexProbeAuth(Buffer.from(subscriptionAuth())))
      .toBe("subscription");
    expect(classifyCodexProbeAuth(Buffer.from("not-json"))).toBe("unsupported");
  });
});

describe("snapshotDurableCodexProbeAuth", () => {
  it("resolves the managed-home auth symlink and reads the bounded regular target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-auth-link-"));
    try {
      const home = path.join(root, "home");
      const shared = path.join(root, "shared-auth.json");
      const bytes = subscriptionAuth("acct-shared");
      await fs.mkdir(home);
      await fs.writeFile(shared, bytes, { mode: 0o600 });
      await fs.symlink(shared, path.join(home, "auth.json"));

      const snapshot = await snapshotDurableCodexProbeAuth(home);

      expect(snapshot.kind).toBe("subscription");
      expect(snapshot.bytes.toString("utf8")).toBe(bytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an auth source larger than the one-megabyte probe bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-auth-large-"));
    try {
      await fs.writeFile(path.join(root, "auth.json"), Buffer.alloc(1024 * 1024 + 1));
      await expect(snapshotDurableCodexProbeAuth(root)).rejects.toThrow(
        "codex_probe_auth_source_invalid",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
