import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAuthTrustedOrigins } from "../auth/better-auth.js";
import { parseChatWebhookPublicBaseUrl } from "../chat-webhook-public-url.js";
import { loadConfig } from "../config.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

const missingConfigPath = path.join(
  os.tmpdir(),
  `paperclip-chat-webhook-url-${process.pid}.json`,
);

function useIsolatedConfigEnvironment() {
  vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
  vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "");
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("BETTER_AUTH_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_BASE_URL_MODE", "");
  vi.stubEnv("PAPERCLIP_ALLOWED_HOSTNAMES", "");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
  vi.stubEnv("PAPERCLIP_BIND", "loopback");
  vi.stubEnv("HOST", "127.0.0.1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat webhook public URL", () => {
  it("accepts only a credential-free HTTPS origin", () => {
    expect(parseChatWebhookPublicBaseUrl(undefined)).toBeUndefined();
    expect(parseChatWebhookPublicBaseUrl("   ")).toBeUndefined();
    expect(
      parseChatWebhookPublicBaseUrl(" https://hooks.example.test:8443/ "),
    ).toBe("https://hooks.example.test:8443");

    for (const invalid of [
      "http://hooks.example.test",
      "https://user:password@hooks.example.test",
      "https://hooks.example.test/provider",
      "https://hooks.example.test/?token=synthetic-canary",
      "https://hooks.example.test/#synthetic-canary",
    ]) {
      expect(() => parseChatWebhookPublicBaseUrl(invalid)).toThrow(
        "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL must be an HTTPS origin",
      );
    }
  });

  it("fails invalid explicit configuration without echoing its value", () => {
    const canary = "synthetic-webhook-origin-secret";
    useIsolatedConfigEnvironment();
    vi.stubEnv(
      "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL",
      `https://user:${canary}@hooks.example.test/private?token=${canary}`,
    );

    let message = "";
    try {
      loadConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL must be an HTTPS origin",
    );
    expect(message).not.toContain(canary);
  });

  it("keeps webhook ingress separate from board auth and host trust", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv(
      "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL",
      "https://hooks.example.test/",
    );

    const config = loadConfig();

    expect(config.chatWebhookPublicBaseUrl).toBe("https://hooks.example.test");
    expect(config.authPublicBaseUrl).toBeUndefined();
    expect(config.allowedHostnames).not.toContain("hooks.example.test");
    expect(deriveAuthTrustedOrigins(config)).not.toContain(
      "https://hooks.example.test",
    );
  });

  it("does not trust the webhook-only origin for board mutations", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv(
      "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL",
      "https://hooks.example.test",
    );
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      socket: { remoteAddress: "127.0.0.1" },
      app: { get: () => undefined },
      header: (name: string) => {
        if (name === "host") return "127.0.0.1:3103";
        if (name === "origin") return "https://hooks.example.test";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("preserves the existing board origin while using a distinct webhook origin", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://board.example.test");
    vi.stubEnv(
      "PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL",
      "https://hooks.example.test",
    );

    const config = loadConfig();

    expect(config.authPublicBaseUrl).toBe("https://board.example.test");
    expect(config.chatWebhookPublicBaseUrl).toBe("https://hooks.example.test");
    expect(config.allowedHostnames).toContain("board.example.test");
    expect(config.allowedHostnames).not.toContain("hooks.example.test");
  });
});
