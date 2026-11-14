import type { Db } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { HttpError } from "../../../errors.js";
import type { EndpointRow } from "../runtime-types.js";
import { resolveSlackCloudSigningSecret } from "./cloud-signing-secret.js";

it.each([400, 401, 403, 404, 422])("credential resolution %s cannot authenticate or acknowledge a receipt", async status => {
  const resolve = vi.fn(async (): Promise<Record<string, string>> => { throw new HttpError(status, "synthetic"); });
  await expect(resolveSlackCloudSigningSecret(resolve, {} as EndpointRow, {} as Db, ["signingSecret"]))
    .rejects.toMatchObject({ code: "signing_credential_unavailable", disposition: "attention" });
});

it("empty credential is attention, while transient failures retain their retry classification", async () => {
  await expect(resolveSlackCloudSigningSecret(async () => ({}), {} as EndpointRow))
    .rejects.toMatchObject({ code: "signing_credential_unavailable", disposition: "attention" });
  const transient = new Error("database temporarily unavailable");
  await expect(resolveSlackCloudSigningSecret(async () => { throw transient; }, {} as EndpointRow)).rejects.toBe(transient);
  await expect(resolveSlackCloudSigningSecret(async () => ({ signingSecret: "synthetic" }), {} as EndpointRow)).resolves.toBe("synthetic");
});
