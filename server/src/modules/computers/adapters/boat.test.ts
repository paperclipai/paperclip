import { describe, it, expect, vi } from "vitest";
import { boatBackend } from "./boat.js";
import type { ComputerRecord } from "../domain/ledger.js";
const record: ComputerRecord = {
  id: "computer",
  companyId: "company",
  environmentId: "environment",
  providerId: "bx_test",
  ledger: {
    controllerId: "controller",
    status: "attached",
    secretRef: { type: "secret_ref", secretId: "secret" },
    owners: [],
    placements: {},
    action: null,
  },
};
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
describe("Boat transport validation", () => {
  it("recognizes idle as an already running computer", async () => {
    const fetcher = vi.fn(async () =>
      json({
        sandbox: { id: "bx_test", state: "idle", snapshots: true, stop: null },
      }),
    );
    await boatBackend(async () => "secret", fetcher).ready(record);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects another physical ID and snapshot-disabled computers", async () => {
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_wrong", state: "idle", snapshots: true } }),
        ),
      ).inspect(record),
    ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_test", state: "idle", snapshots: false } }),
        ),
      ).ready(record),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("keeps port credentials out of the WSS URL and does not forward API authorization to the hosting origin", async () => {
    const fetcher = vi.fn(async (url: any, options?: any) =>
      String(url).startsWith("https://boat.dev/")
        ? json({
            url: "https://test.on.boat.dev/?_token=private-token",
            access: "private",
          })
        : new Response(null, {
            status: 302,
            headers: {
              "set-cookie": "_port_auth=private-cookie; Secure; HttpOnly",
            },
          }),
    );
    const endpoint = await boatBackend(
      async () => "api-secret",
      fetcher,
    ).ingress(record, 43127, "/runner/ws");
    expect(endpoint).toEqual({
      url: "wss://test.on.boat.dev/runner/ws",
      secretHeaders: { Cookie: "_port_auth=private-cookie" },
    });
    expect(fetcher.mock.calls[1]![1].headers).toBeUndefined();
    expect(fetcher.mock.calls[1]![1].redirect).toBe("manual");
  });
  it("refuses public ports and arbitrary hosting origins", async () => {
    for (const url of [
      "http://test.on.boat.dev/?_token=x",
      "https://evil.example/?_token=x",
    ])
      await expect(
        boatBackend(
          async () => "secret",
          vi.fn(async () => json({ url, access: "private" })),
        ).preview(record, 5173),
      ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ url: "https://test.on.boat.dev/", access: "public" }),
        ),
      ).preview(record, 5173),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});
