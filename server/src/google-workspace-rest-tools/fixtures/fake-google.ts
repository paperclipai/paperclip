import type { GoogleFetch } from "../google-http.js";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function fakeGoogle(route: Route): { fetch: GoogleFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: GoogleFetch = async (url, init) => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call);
  };
  return { fetch, calls };
}
