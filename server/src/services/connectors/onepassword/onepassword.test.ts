import { describe, expect, it, vi } from "vitest";
import type { Client, Item } from "@1password/sdk";
import { ONEPASSWORD_TOOLS, isOnePasswordConnection, onePasswordArguments } from "./catalog.js";
import { executeOnePasswordSdk } from "./sdk.js";
import { callOnePassword, executeOnePasswordTool } from "./client.js";

const vaultId = "a".repeat(26), itemId = "b".repeat(26);
describe("1Password provider contract", () => {
  it("rejects another company and an expired dispatch before starting the SDK", () => {
    const input = { binding: { companyId: "company-a", agentId: "agent" }, connection: { companyId: "company-b" },
      headers: {}, toolName: "onepassword_list_vaults", parameters: {} };
    expect(() => executeOnePasswordTool(input)).toThrow("Connection not found");
    expect(() => executeOnePasswordTool({ ...input, connection: { companyId: "company-a" }, deadlineAt: Date.now() - 1 })).toThrow("timed out");
  });
  it("rejects unreviewed actions, unknown input, invalid IDs and empty updates before authentication", async () => {
    const authenticate = vi.fn();
    for (const [tool, args] of [
      ["onepassword_run_command", {}], ["onepassword_list_vaults", { token: "ambient" }],
      ["onepassword_get_item", { vaultId: "../escape", itemId }],
      ["onepassword_update_item", { vaultId, itemId }],
      ["onepassword_create_item", { vaultId, title: "test", category: "Login", extra: true }],
    ] as const) await expect(executeOnePasswordSdk("unused", tool, args, authenticate)).rejects.toThrow();
    expect(authenticate).not.toHaveBeenCalled();
    expect(ONEPASSWORD_TOOLS).toHaveLength(8);
    expect(isOnePasswordConnection({ transport: "rest_api", config: { sourceTemplateKey: "1password", connectionMethodKey: "service-account", url: "https://attacker.example" } })).toBe(false);
  });

  it("preserves item version and omitted properties when applying a patch", async () => {
    const current = { id: itemId, vaultId, title: "Keep", version: 4, fields: [], tags: ["keep"], notes: "before" } as unknown as Item;
    const put = vi.fn(async item => item);
    const client = { items: { get: vi.fn(async () => current), put } } as unknown as Client;
    const authenticate = vi.fn(async () => client);
    await executeOnePasswordSdk("ops_selected", "onepassword_update_item", { vaultId, itemId, notes: "after" }, authenticate);
    expect(authenticate).toHaveBeenCalledWith("ops_selected");
    expect(put).toHaveBeenCalledWith({ ...current, notes: "after" });
    expect(onePasswordArguments("onepassword_resolve_secret", { reference: `op://${vaultId}/${itemId}/password` })).toBeTruthy();
  });

  it("sends reviewed create, archive and delete operations to the correct SDK boundary", async () => {
    const params = { vaultId, title: "Disposable item", category: "SecureNote", notes: "Synthetic data",
      fields: [{ id: "secret", title: "Test secret", fieldType: "Concealed", value: "synthetic-secret" }] };
    const item = { ...params, id: itemId, version: 1 } as unknown as Item;
    const create = vi.fn(async (_params: unknown) => item);
    const archive = vi.fn(async (_vaultId: string, _itemId: string) => {}), remove = vi.fn(async (_vaultId: string, _itemId: string) => {});
    const client = { items: { create, archive, delete: remove } } as unknown as Client;
    const authenticate = vi.fn(async () => client);
    expect(await executeOnePasswordSdk("ops_selected", "onepassword_create_item", params, authenticate)).toBe(item);
    expect(create).toHaveBeenCalledExactlyOnceWith(params);
    expect(await executeOnePasswordSdk("ops_selected", "onepassword_archive_item", { vaultId, itemId }, authenticate)).toEqual({ archived: true });
    expect(archive).toHaveBeenCalledExactlyOnceWith(vaultId, itemId);
    expect(remove).not.toHaveBeenCalled();
    expect(await executeOnePasswordSdk("ops_selected", "onepassword_delete_item", { vaultId, itemId }, authenticate)).toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith(vaultId, itemId);
  });

  it.each(["create", "archive", "delete"] as const)("propagates a rejected SDK %s without retrying or reporting success", async method => {
    const denied = new Error("Provider denied the synthetic mutation");
    const operation = vi.fn(async () => { throw denied; });
    const client = { items: { [method]: operation } } as unknown as Client;
    const args = method === "create" ? { vaultId, title: "Disposable", category: "SecureNote" } : { vaultId, itemId };
    await expect(executeOnePasswordSdk("ops_selected", `onepassword_${method}_item`, args, async () => client)).rejects.toBe(denied);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("terminates real SDK work on deadline without blocking unrelated work or leaking the token", async () => {
    const token = `ops_${Buffer.from(JSON.stringify({ signInAddress: "my.1password.com" })).toString("base64url")}`;
    const start = Date.now();
    const unrelated = new Promise(resolve => setTimeout(() => resolve("responsive"), 5));
    const result = await callOnePassword({ Authorization: `Bearer ${token}` }, "onepassword_list_vaults", {}, 1).catch(error => error);
    expect(result).toMatchObject({ status: 504 });
    expect(String(result).includes(token)).toBe(false);
    expect(await unrelated).toBe("responsive");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it.each(["http://my.1password.com", "https://127.0.0.1", "https://my.1password.com.attacker.example", "https://my.1password.com:8443", "https://my.1password.com/path"])("rejects a forged account endpoint: %s", async signInAddress => {
    const token = `ops_${Buffer.from(JSON.stringify({ signInAddress })).toString("base64url")}`;
    await expect(callOnePassword({ Authorization: `Bearer ${token}` }, "onepassword_list_vaults", {})).rejects.toMatchObject({ status: 422 });
  });
});
