import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import plugin from "./worker.js";

const SESSION_KEY = `sk-ant-sid02-${"x".repeat(64)}`;

function apiInput(body: Record<string, unknown>): PluginApiRequestInput {
  return {
    routeKey: "set-session",
    body,
  } as PluginApiRequestInput;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ccrotate set-session route", () => {
  it("chains pasted Claude session keys through reloginViaSession", async () => {
    vi.stubEnv("CCROTATE_AUTH_BOT_URL", "http://auth-bot.test:7000");
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true });
    }));

    const result = await plugin.definition.onApiRequest?.(apiInput({
      email: "ssh-users+1@blockcast.net",
      target: "claude",
      sessionKey: SESSION_KEY,
    }));

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, email: "ssh-users+1@blockcast.net" },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://auth-bot.test:7000/setSession",
      "http://auth-bot.test:7000/reloginViaSession",
    ]);
    expect(calls[1]?.body).toEqual({
      email: "ssh-users+1@blockcast.net",
      target: "claude",
    });
  });

  it("keeps sessionKey persisted semantics when reloginViaSession fails", async () => {
    vi.stubEnv("CCROTATE_AUTH_BOT_URL", "http://auth-bot.test:7000");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/setSession")) return jsonResponse({ ok: true });
      return jsonResponse({
        ok: false,
        error: "upstream refused session replay",
        code: "SESSION_REPLAY_FAILED",
        reason: "select_account",
      }, 503);
    }));

    const result = await plugin.definition.onApiRequest?.(apiInput({
      email: "ssh-users+1@blockcast.net",
      target: "claude",
      sessionKey: SESSION_KEY,
    }));

    expect(result).toMatchObject({
      status: 503,
      body: {
        ok: false,
        sessionKeyPersisted: true,
        code: "SESSION_REPLAY_FAILED",
        reason: "select_account",
      },
    });
    expect(String((result?.body as { error?: unknown })?.error)).toContain(
      "sessionKey saved but bot /reloginViaSession returned 503",
    );
  });
});
