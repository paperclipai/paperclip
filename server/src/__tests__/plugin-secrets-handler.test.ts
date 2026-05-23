import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  createPluginSecretsHandler,
  isPluginSecretRefsDisabled,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

const SECRET_ID = "77777777-7777-4777-8777-777777777777";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";

function createMockDb(secret?: { id: string; companyId: string; status: string }) {
  const limit = vi.fn().mockResolvedValue(secret ? [secret] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as never;
}

describe("isPluginSecretRefsDisabled", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED;
  });

  it("defaults to enabled", () => {
    expect(isPluginSecretRefsDisabled()).toBe(false);
  });

  it("honours PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED=true", () => {
    process.env.PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED = "true";
    expect(isPluginSecretRefsDisabled()).toBe(true);
  });
});

describe("createPluginSecretsHandler", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED;
    mockResolveSecretValue.mockReset();
  });

  it("fails closed when PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED=true", async () => {
    process.env.PAPERCLIP_PLUGIN_SECRET_REFS_DISABLED = "true";
    const handler = createPluginSecretsHandler({
      db: createMockDb(),
      pluginId: PLUGIN_ID,
    });

    await expect(handler.resolve({ secretRef: SECRET_ID })).rejects.toThrow(
      PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
    );
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
  });

  it("resolves active secrets by UUID via secretService", async () => {
    mockResolveSecretValue.mockResolvedValue("resolved-secret-value");
    const handler = createPluginSecretsHandler({
      db: createMockDb({ id: SECRET_ID, companyId: COMPANY_ID, status: "active" }),
      pluginId: PLUGIN_ID,
    });

    await expect(handler.resolve({ secretRef: SECRET_ID })).resolves.toBe(
      "resolved-secret-value",
    );
    expect(mockResolveSecretValue).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, "latest");
  });

  it("returns not found when the secret UUID does not exist", async () => {
    const handler = createPluginSecretsHandler({
      db: createMockDb(),
      pluginId: PLUGIN_ID,
    });

    await expect(handler.resolve({ secretRef: SECRET_ID })).rejects.toSatisfy(
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  it("rejects inactive secrets", async () => {
    const handler = createPluginSecretsHandler({
      db: createMockDb({ id: SECRET_ID, companyId: COMPANY_ID, status: "archived" }),
      pluginId: PLUGIN_ID,
    });

    await expect(handler.resolve({ secretRef: SECRET_ID })).rejects.toThrow(
      /invalid secret reference/i,
    );
  });

  it("still rejects malformed secret refs before resolution", async () => {
    const handler = createPluginSecretsHandler({
      db: createMockDb(),
      pluginId: PLUGIN_ID,
    });

    await expect(handler.resolve({ secretRef: "not-a-uuid" })).rejects.toThrow(
      /invalid secret reference/i,
    );
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
  });
});
