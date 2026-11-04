import http from "node:http";
import https from "node:https";
import { expect, vi } from "vitest";

/** Test-only wire guard. Unexpected external requests fail before socket creation. */
export function guardSlackFixtureNetwork() {
  const blocked: string[] = [];
  const check = (value: unknown) => {
    const url = value instanceof URL ? value : typeof value === "string" ? new URL(value) : undefined;
    const options = value as { hostname?: string; host?: string } | undefined;
    const host = url?.hostname ?? options?.hostname ?? options?.host ?? "localhost";
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
      blocked.push(host);
      throw new Error("Unexpected off-host Slack fixture request");
    }
  };
  const realHttp = http.request, realHttps = https.request, realFetch = globalThis.fetch;
  const httpSpy = vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
    check(args[0]); return Reflect.apply(realHttp, http, args);
  }) as typeof http.request);
  const httpsSpy = vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
    check(args[0]); return Reflect.apply(realHttps, https, args);
  }) as typeof https.request);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    check(input instanceof Request ? input.url : input); return realFetch(input, init);
  });
  return { assertQuiet: () => expect(blocked).toEqual([]), restore: () => {
    fetchSpy.mockRestore(); httpsSpy.mockRestore(); httpSpy.mockRestore();
  } };
}

/** Real pinned WebClient still serializes/authenticates; only its HTTP adapter is synthetic. */
export function stubSlackFixtureTransport(adapter: unknown) {
  const client = (adapter as { _client: { axios: { defaults: { adapter: unknown } } } })._client;
  const transport = vi.fn(async (config: { url: string; baseURL: string }) => {
    const url = new URL(config.url, config.baseURL);
    if (url.hostname !== "127.0.0.1") throw new Error("Slack fixture API origin changed");
    let data: unknown;
    if (url.pathname.endsWith("/users.info")) data = { ok: true, user: { id: "UOPERATOR", name: "operator", is_bot: false, profile: { display_name: "Operator" } } };
    else if (url.pathname.endsWith("/conversations.info")) data = { ok: true, channel: { id: "CTEST", name: "fixture" } };
    else throw new Error(`Unexpected Slack fixture API method ${url.pathname}`);
    return { data, status: 200, statusText: "OK", headers: {}, config };
  });
  client.axios.defaults.adapter = transport;
  return transport;
}
