import { afterEach, describe, expect, it, vi } from "vitest";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";

const account = vi.hoisted(() => {
  const refs = [{ configPath: "ai.credential", secretId: "22222222-2222-4222-8222-222222222222", versionSelector: "latest" }];
  return {
    refs,
    credential: "fixture-selected-google-key",
    selection: {
      grant: { id: "11111111-1111-4111-8111-111111111111", subjectUserId: "alice", credentialSecretRefs: refs },
      connection: { id: "33333333-3333-4333-8333-333333333333", name: "Google AI fixture", config: { ai: { provider: "google", method: "api_key" } } },
      attribution: { connectionId: "33333333-3333-4333-8333-333333333333", grantId: "11111111-1111-4111-8111-111111111111",
        provider: "google", method: "api_key", mode: "responsible_user", responsibleUserId: "alice" },
    },
  };
});

// This fixture exercises real private-home preparation and deletion. The DB-backed
// ai-connections suite separately checks membership, selected grants and revocation.
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({
  select: async () => account.selection,
  runtimeCredential: async () => account.credential,
}) }));
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn() }));
import { managedAiSessionFingerprintConfig, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

describe("Antigravity private managed AI home", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the selected key and explicit native auth settings, then deletes both private homes", async () => {
    vi.stubEnv("GEMINI_HOME", "/ambient/google-home");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/ambient/google-credentials.json");
    const version = [{ epoch: 1, version: 1 }];
    const db = { select: (fields: Record<string, unknown>) => ({ from: () => ({
      where: () => Object.assign(Promise.resolve("refs" in fields ? [{ refs: account.refs, status: "active" }] : version),
        { limit: async () => version }),
    }) }) } as unknown as Db;
    const input = {
      companyId: "44444444-4444-4444-8444-444444444444", agentId: "55555555-5555-4555-8555-555555555555", responsibleUserId: "alice",
      adapterType: "paperclip_runner", binding: { provider: "google", method: "api_key", mode: "responsible_user" } as const,
      config: { provider: "acpx", acpxAgent: "antigravity", model: "caller-exact-model", env: {
        GEMINI_API_KEY: "fixture-ambient-key", GOOGLE_API_KEY: "fixture-other-key", GEMINI_HOME: "/ambient/configured-home",
        GOOGLE_APPLICATION_CREDENTIALS: "/ambient/configured-credentials.json", GOOGLE_CLOUD_ACCESS_TOKEN: "fixture-oauth-token",
      } },
    };
    const first = await prepareManagedAiRuntime(db, input);
    const second = await prepareManagedAiRuntime(db, input);
    try {
      expect(first.config).toMatchObject({ provider: "acpx", acpxAgent: "antigravity", model: "caller-exact-model", env: {
        GEMINI_API_KEY: account.credential, GOOGLE_API_KEY: "", GOOGLE_APPLICATION_CREDENTIALS: "", GOOGLE_CLOUD_ACCESS_TOKEN: "",
      } });
      expect(first.home).not.toBe(second.home);
      expect(first.config.env.GEMINI_HOME).toBe(path.join(first.home!, "provider"));
      const settingsPath = path.join(String(first.config.env.GEMINI_HOME), "antigravity-acp", "settings.json");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ auth: { type: "gemini-api-key" } });
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
      expect(managedAiSessionFingerprintConfig(first.config, first.home)).toEqual(managedAiSessionFingerprintConfig(second.config, second.home));
      expect(input.config.env.GEMINI_HOME).toBe("/ambient/configured-home");
    } finally { await Promise.all([first.cleanup(), second.cleanup()]); }
    await expect(access(first.home!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.home!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
