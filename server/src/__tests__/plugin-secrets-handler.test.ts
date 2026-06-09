import { describe, expect, it, vi } from "vitest";
import {
  createPluginSecretsHandler,
} from "../services/plugin-secrets-handler.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET_ID = "77777777-7777-4777-8777-777777777777";
const SECRET_VALUE = "super-secret-value";

function makeHandler(resolveSecretValue = vi.fn().mockResolvedValue(SECRET_VALUE)) {
  return {
    handler: createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
      resolveSecretValue,
    }),
    resolveSecretValue,
  };
}

function scope(companyId: string) {
  return { invocationScope: { companyId } };
}

describe("createPluginSecretsHandler", () => {
  describe("format validation", () => {
    it("rejects empty secretRef", async () => {
      const { handler } = makeHandler();
      await expect(handler.resolve({ secretRef: "" })).rejects.toMatchObject({
        name: "InvalidSecretRefError",
      });
    });

    it("rejects non-UUID secretRef", async () => {
      const { handler } = makeHandler();
      await expect(
        handler.resolve({ secretRef: "not-a-uuid" }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });
  });

  describe("invocation scope guard", () => {
    it("fails closed when context is absent", async () => {
      const { handler } = makeHandler();
      await expect(
        handler.resolve({ secretRef: SECRET_ID }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("fails closed when invocationScope is null", async () => {
      const { handler } = makeHandler();
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, { invocationScope: null }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("fails closed when invalidInvocationScope is true", async () => {
      const { handler } = makeHandler();
      await expect(
        handler.resolve(
          { secretRef: SECRET_ID },
          { invalidInvocationScope: true, invocationScope: { companyId: COMPANY_ID } },
        ),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });
  });

  describe("successful resolution", () => {
    it("calls resolveSecretValue with the acting company ID and returns the value", async () => {
      const { handler, resolveSecretValue } = makeHandler();
      const result = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID));
      expect(result).toBe(SECRET_VALUE);
      expect(resolveSecretValue).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, "latest");
    });

    it("trims whitespace from secretRef before passing to resolver", async () => {
      const { handler, resolveSecretValue } = makeHandler();
      await handler.resolve({ secretRef: `  ${SECRET_ID}  ` }, scope(COMPANY_ID));
      expect(resolveSecretValue).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, "latest");
    });
  });

  describe("error masking (cross-company oracle prevention)", () => {
    it("masks resolveSecretValue errors as InvalidSecretRefError", async () => {
      const { handler } = makeHandler(vi.fn().mockRejectedValue(new Error("secret not found")));
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("does not leak the original error message", async () => {
      const { handler } = makeHandler(
        vi.fn().mockRejectedValue(new Error("Secret must belong to same company")),
      );
      const err = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch((e) => e);
      expect(err.message).not.toContain("same company");
      expect(err.name).toBe("InvalidSecretRefError");
    });

    it("masked error contains the secretRef UUID (for diagnostics), not the resolved value", async () => {
      const { handler } = makeHandler(vi.fn().mockRejectedValue(new Error("boom")));
      const err = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch((e) => e);
      expect(err.message).toContain(SECRET_ID);
      expect(err.message).not.toContain(SECRET_VALUE);
    });
  });

  describe("rate limiting", () => {
    it("throws RateLimitExceededError after 30 attempts per minute", async () => {
      const { handler } = makeHandler();
      // exhaust the 30-per-minute quota
      for (let i = 0; i < 30; i++) {
        await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch(() => undefined);
      }
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "RateLimitExceededError" });
    });
  });
});
