import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemCategory, ItemFieldType, type Item } from "@1password/sdk";
import {
  createOnePasswordProvider,
  type OnePasswordItemsGateway,
} from "../secrets/onepassword-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

function fakeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    title: "paperclip/company-1/openai-api-key",
    category: ItemCategory.ApiCredentials,
    vaultId: "vault-1",
    fields: [
      { id: "paperclip_value", title: "value", fieldType: ItemFieldType.Concealed, value: "super-secret-value" },
    ],
    sections: [],
    notes: "",
    tags: ["paperclip-managed", "paperclip-company:company-1", "paperclip-secret:openai-api-key"],
    websites: [],
    version: 1,
    files: [],
    createdAt: new Date("2026-05-06T00:00:00.000Z"),
    updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("onePasswordProvider", () => {
  const previousEnv = {
    OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID: process.env.PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("creates Paperclip-managed 1Password items without persisting plaintext in provider material", async () => {
    const calls: Array<{ op: string; input: unknown }> = [];
    const gateway: OnePasswordItemsGateway = {
      async create(params) {
        calls.push({ op: "create", input: params });
        return fakeItem({ id: "item-1", version: 1 });
      },
      async get() {
        throw new Error("not used");
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const prepared = await provider.createSecret({
      value: "super-secret-value",
      context: { companyId: "company-1", secretKey: "openai-api-key", secretName: "OpenAI API key", version: 1 },
    });

    expect(calls).toEqual([
      {
        op: "create",
        input: expect.objectContaining({
          vaultId: "vault-1",
          title: "paperclip/company-1/openai-api-key",
          tags: ["paperclip-managed", "paperclip-company:company-1", "paperclip-secret:openai-api-key"],
        }),
      },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toBe("vault-1/item-1#paperclip_value");
    expect(prepared.providerVersionRef).toBe("1");
  });

  it("creates new versions by updating the existing item's field in place", async () => {
    const calls: Array<{ op: string; input: unknown }> = [];
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get(vaultId, itemId) {
        calls.push({ op: "get", input: { vaultId, itemId } });
        return fakeItem();
      },
      async put(item) {
        calls.push({ op: "put", input: item });
        return { ...item, version: 2 };
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const prepared = await provider.createVersion({
      value: "rotated-secret-value",
      externalRef: "vault-1/item-1#paperclip_value",
      context: { companyId: "company-1", secretKey: "openai-api-key", secretName: "OpenAI API key", version: 2 },
    });

    expect(calls[1]).toMatchObject({
      op: "put",
      input: expect.objectContaining({
        fields: [expect.objectContaining({ id: "paperclip_value", value: "rotated-secret-value" })],
      }),
    });
    expect(JSON.stringify(prepared)).not.toContain("rotated-secret-value");
    expect(prepared.providerVersionRef).toBe("2");
  });

  it("rejects writes against another company's Paperclip-managed item", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return fakeItem({ tags: ["paperclip-managed", "paperclip-company:company-2"] });
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    await expect(
      provider.createVersion({
        value: "rotated-secret-value",
        externalRef: "vault-1/item-1#paperclip_value",
        context: { companyId: "company-1", secretKey: "openai-api-key", secretName: "OpenAI API key", version: 2 },
      }),
    ).rejects.toThrow(/drifted outside the derived company scope/i);
  });

  it("stores linked external references as metadata-only provider material", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return fakeItem({ tags: [] });
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const prepared = await provider.linkExternalSecret({
      externalRef: "vault-1/item-1#paperclip_value",
      providerVersionRef: "1",
    });

    expect(prepared.externalRef).toBe("vault-1/item-1#paperclip_value");
    expect(prepared.providerVersionRef).toBe("1");
    expect(prepared.valueSha256).toBeTruthy();
  });

  it("rejects linking another company's Paperclip-managed item as an external reference", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return fakeItem({ tags: ["paperclip-managed", "paperclip-company:company-2"] });
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    await expect(
      provider.linkExternalSecret({ externalRef: "vault-1/item-1#paperclip_value" }),
    ).rejects.toThrow(/Paperclip-managed items from another company/i);
  });

  it("writes new values through to externally referenced items", async () => {
    const calls: Array<{ op: string; input: unknown }> = [];
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get(vaultId, itemId) {
        calls.push({ op: "get", input: { vaultId, itemId } });
        return fakeItem({ tags: [] });
      },
      async put(item) {
        calls.push({ op: "put", input: item });
        return { ...item, version: 3 };
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const prepared = await provider.updateExternalSecretValue!({
      externalRef: "vault-1/item-1#paperclip_value",
      value: "written-through-value",
    });

    expect(JSON.stringify(prepared.material)).not.toContain("written-through-value");
    expect(prepared.externalRef).toBe("vault-1/item-1#paperclip_value");
    expect(prepared.providerVersionRef).toBe("3");
  });

  it("resolves the current field value by provider version reference", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return fakeItem({ version: 2 });
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const resolved = await provider.resolveVersion({
      material: { scheme: "onepassword_item_v1", vaultId: "vault-1", itemId: "item-1", fieldId: "paperclip_value", source: "managed" },
      externalRef: "vault-1/item-1#paperclip_value",
      providerVersionRef: "2",
    });

    expect(resolved).toBe("super-secret-value");
  });

  it("rejects resolving a stale provider version reference since 1Password has no historical-version read", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return fakeItem({ version: 3 });
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    let thrown: unknown;
    try {
      await provider.resolveVersion({
        material: { scheme: "onepassword_item_v1", vaultId: "vault-1", itemId: "item-1", fieldId: "paperclip_value", source: "managed" },
        externalRef: "vault-1/item-1#paperclip_value",
        providerVersionRef: "2",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretProviderClientError);
    expect(thrown).toMatchObject({ code: "conflict" });
  });

  it("deletes and archives managed items without touching external references", async () => {
    const calls: Array<{ op: string; input: unknown }> = [];
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("not used");
      },
      async put() {
        throw new Error("not used");
      },
      async delete(vaultId, itemId) {
        calls.push({ op: "delete", input: { vaultId, itemId } });
      },
      async archive(vaultId, itemId) {
        calls.push({ op: "archive", input: { vaultId, itemId } });
      },
      async list() {
        return [];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    await provider.deleteOrArchive({
      mode: "delete",
      externalRef: "vault-1/item-1#paperclip_value",
      material: { scheme: "onepassword_item_v1", vaultId: "vault-1", itemId: "item-1", fieldId: "paperclip_value", source: "managed" },
    });
    await provider.deleteOrArchive({
      mode: "archive",
      externalRef: "vault-1/item-2#paperclip_value",
      material: { scheme: "onepassword_item_v1", vaultId: "vault-1", itemId: "item-2", fieldId: "paperclip_value", source: "managed" },
    });
    await provider.deleteOrArchive({
      mode: "delete",
      externalRef: "vault-1/item-3#paperclip_value",
      material: { scheme: "onepassword_item_v1", vaultId: "vault-1", itemId: "item-3", fieldId: "paperclip_value", source: "external_reference" },
    });

    expect(calls).toEqual([
      { op: "delete", input: { vaultId: "vault-1", itemId: "item-1" } },
      { op: "archive", input: { vaultId: "vault-1", itemId: "item-2" } },
    ]);
  });

  it("lists remote items with metadata only and never resolves field values", async () => {
    const gateway: OnePasswordItemsGateway = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("GetItem must not be used for remote import preview");
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {},
      async archive() {},
      async list(vaultId) {
        expect(vaultId).toBe("vault-1");
        return [{ id: "item-1", title: "OpenAI API key", category: "ApiCredentials", tags: ["team:platform"] }];
      },
    };
    const provider = createOnePasswordProvider({
      config: { vaultId: "vault-1", fieldId: "paperclip_value", itemTitlePrefix: "paperclip" },
      gateway,
    });

    const listed = await provider.listRemoteSecrets?.({ query: "openai", pageSize: 25 });

    expect(listed).toEqual({
      nextToken: null,
      secrets: [
        {
          externalRef: "vault-1/item-1#paperclip_value",
          name: "OpenAI API key",
          providerVersionRef: null,
          metadata: { category: "ApiCredentials", tags: ["team:platform"] },
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("super-secret-value");
  });

  it("warns when 1Password configuration is incomplete and blocks managed writes", async () => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID;

    const provider = createOnePasswordProvider();
    const health = await provider.healthCheck();

    expect(health.status).toBe("warn");
    expect(health.details).toMatchObject({
      missingConfig: expect.arrayContaining(["OP_SERVICE_ACCOUNT_TOKEN"]),
    });
    await expect(
      provider.createSecret({
        value: "super-secret-value",
        context: { companyId: "company-1", secretKey: "openai-api-key", secretName: "OpenAI API key", version: 1 },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID/i);
  });
});
