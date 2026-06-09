import { describe, expect, it, vi } from "vitest";
import {
  createPluginSecretsHandler,
} from "../services/plugin-secrets-handler.js";
import * as secretsModule from "../services/secrets.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET_ID = "77777777-7777-4777-8777-777777777777";
const SECRET_VALUE = "super-secret-value";
const MOCK_DB = {} as never;

function scope(companyId: string) {
  return { invocationScope: { companyId } };
}

function makeHandler(resolveSecretValue = vi.fn().mockResolvedValue(SECRET_VALUE)) {
  vi.spyOn(secretsModule, "secretService").mockReturnValue({
    resolveSecretValue,
  } as unknown as ReturnType<typeof secretsModule.secretService>);
  return createPluginSecretsHandler({ db: MOCK_DB, pluginId: PLUGIN_ID });
}

describe("createPluginSecretsHandler", () => {
  describe("format validation", () => {
    it("rejects empty secretRef", async () => {
      const handler = makeHandler();
      await expect(handler.resolve({ secretRef: "" })).rejects.toMatchObject({
        name: "InvalidSecretRefError",
      });
    });

    it("rejects non-UUID secretRef", async () => {
      const handler = makeHandler();
      await expect(
        handler.resolve({ secretRef: "not-a-uuid" }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });
  });

  describe("invocation scope guard", () => {
    it("fails closed when context is absent", async () => {
      const handler = makeHandler();
      await expect(
        handler.resolve({ secretRef: SECRET_ID }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("fails closed when invocationScope is null", async () => {
      const handler = makeHandler();
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, { invocationScope: null }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("fails closed when invalidInvocationScope is true (no invocationScope)", async () => {
      // contextForWorkerMessage always returns either {invocationScope} or {invalidInvocationScope: true},
      // never both — so when invalidInvocationScope is set, invocationScope is absent.
      const handler = makeHandler();
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, { invalidInvocationScope: true }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });
  });

  describe("successful resolution", () => {
    it("calls secretService.resolveSecretValue with acting company and returns the value", async () => {
      const resolve = vi.fn().mockResolvedValue(SECRET_VALUE);
      const handler = makeHandler(resolve);
      const result = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID));
      expect(result).toBe(SECRET_VALUE);
      expect(resolve).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, "latest");
    });

    it("trims whitespace from secretRef before passing to resolver", async () => {
      const resolve = vi.fn().mockResolvedValue(SECRET_VALUE);
      const handler = makeHandler(resolve);
      await handler.resolve({ secretRef: `  ${SECRET_ID}  ` }, scope(COMPANY_ID));
      expect(resolve).toHaveBeenCalledWith(COMPANY_ID, SECRET_ID, "latest");
    });
  });

  describe("error masking (cross-company oracle prevention)", () => {
    it("masks 404 HttpError as InvalidSecretRefError", async () => {
      const { HttpError } = await import("../errors.js");
      const handler = makeHandler(
        vi.fn().mockRejectedValue(new HttpError(404, "Secret not found")),
      );
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    });

    it("masks 422 HttpError as InvalidSecretRefError", async () => {
      const { HttpError } = await import("../errors.js");
      const handler = makeHandler(
        vi.fn().mockRejectedValue(new HttpError(422, "Secret must belong to same company")),
      );
      const err = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch((e) => e);
      expect(err.name).toBe("InvalidSecretRefError");
      expect(err.message).not.toContain("same company");
    });

    it("re-throws non-404/422 errors (e.g. provider connectivity)", async () => {
      const { HttpError } = await import("../errors.js");
      const handler = makeHandler(
        vi.fn().mockRejectedValue(new HttpError(503, "Provider unavailable")),
      );
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ status: 503 });
    });

    it("masked error contains the secretRef UUID, not the resolved value", async () => {
      const { HttpError } = await import("../errors.js");
      const handler = makeHandler(
        vi.fn().mockRejectedValue(new HttpError(404, "not found")),
      );
      const err = await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch((e) => e);
      expect(err.message).toContain(SECRET_ID);
      expect(err.message).not.toContain(SECRET_VALUE);
    });
  });

  describe("rate limiting", () => {
    it("throws RateLimitExceededError after 30 attempts per minute", async () => {
      const handler = makeHandler();
      for (let i = 0; i < 30; i++) {
        await handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)).catch(() => undefined);
      }
      await expect(
        handler.resolve({ secretRef: SECRET_ID }, scope(COMPANY_ID)),
      ).rejects.toMatchObject({ name: "RateLimitExceededError" });
    });
  });
});
