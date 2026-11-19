/**
 * Shared harness for the worker test files: a plugin instance with the
 * host's company-scoped config contract, fake secret resolution and a fake
 * Telegram API. Tokens are fake fixtures.
 */
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company, PluginCapability } from "@paperclipai/plugin-sdk";
import { vi } from "vitest";
import { STATE_KEY } from "./constants.js";
import manifest from "./manifest.js";
import { setPairedChat } from "./pairing.js";
import type { PairingState, TelegramUpdate } from "./types.js";
import plugin from "./worker.js";

export const TOKEN_A = "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const TOKEN_B = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
// Stored config holds only secret bindings; `setup` resolves them to the tokens.
export const REF_A = { type: "secret_ref", secretId: "00000000-0000-4000-8000-00000000000a", version: "latest" };
export const REF_B = { type: "secret_ref", secretId: "00000000-0000-4000-8000-00000000000b", version: "latest" };
export const SECRET_VALUES: Record<string, string> = {
  [REF_A.secretId]: TOKEN_A,
  [REF_B.secretId]: TOKEN_B,
};

export interface TelegramCall {
  botId: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * Harness with the host's current config contract: config is stored per
 * company and `get()` without a company is rejected, as it is for a
 * scheduled job outside any company-scoped invocation.
 */
export async function setup(
  configs: Record<string, Record<string, unknown>>,
  extraCapabilities: PluginCapability[] = [],
) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, ...extraCapabilities],
  });
  const configReads: Array<string | undefined> = [];
  harness.ctx.config.get = async (companyId?: string) => {
    configReads.push(companyId);
    const config = companyId ? configs[companyId] : undefined;
    if (!config) throw new Error("company context is required");
    return { ...config };
  };

  const secretResolves: Array<{ secretRef: unknown; companyId?: string }> = [];
  harness.ctx.secrets.resolve = async (secretRef, opts) => {
    secretResolves.push({ secretRef, companyId: opts?.companyId });
    const id = typeof secretRef === "object" ? secretRef.secretId : undefined;
    const value = id ? SECRET_VALUES[id] : undefined;
    if (!value) throw new Error("unknown secret");
    return value;
  };

  const calls: TelegramCall[] = [];
  const pendingUpdates = new Map<string, TelegramUpdate[]>();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    const match = String(url).match(/\/bot(\d+):[^/]+\/(\w+)$/);
    if (!match) throw new Error(`unexpected url ${url}`);
    const [, botId, method] = match;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ botId: botId!, method: method!, body });
    let result: unknown = true;
    if (method === "getMe") result = { id: Number(botId), username: `bot${botId}` };
    if (method === "sendMessage") result = { message_id: calls.length };
    if (method === "getUpdates") {
      result = pendingUpdates.get(botId!) ?? [];
      pendingUpdates.delete(botId!);
      // End the 55-second long-poll loop after the first round.
      vi.setSystemTime(Date.now() + 120_000);
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  await plugin.definition.setup(harness.ctx);
  return { harness, configReads, calls, pendingUpdates, secretResolves };
}

export function seedCompany(harness: TestHarness, id: string) {
  harness.seed({ companies: [{ id, name: `Company ${id}` } as unknown as Company] });
}

export async function pair(harness: TestHarness, companyId: string, chatId: string) {
  await setPairedChat(harness.ctx, companyId, {
    chatId,
    chatLabel: `chat ${chatId}`,
    pairedAt: "2026-10-01T00:00:00.000Z",
    pairedByTelegramUserId: 42,
  });
}

export function state(harness: TestHarness): PairingState {
  return (harness.getState({ scopeKind: "instance", stateKey: STATE_KEY }) ??
    {}) as PairingState;
}
