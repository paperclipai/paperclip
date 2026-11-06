import { describe, expect, it } from "vitest";
import { personRead } from "./internal-privacy.js";

function person(request: () => Promise<Response>) {
  return { request } as unknown as Parameters<typeof personRead>[0];
}

describe("authenticated privacy observer response consumption", () => {
  it("returns the exact successful resource body and status", async () => {
    const response = new Response(JSON.stringify({ id: "owned-company", name: "Launch — authorized" }), { status: 200 });
    await expect(personRead(person(async () => response), "/api/companies/owned-company")).resolves.toEqual({
      status: 200, body: JSON.stringify({ id: "owned-company", name: "Launch — authorized" }),
    });
  });

  it.each([403, 404])("returns the genuine %s denial without reading or exposing its body", async status => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    await expect(personRead(person(async () => response), "/api/issues/private")).resolves.toEqual({ status, body: "" });
    expect(cancelled).toBe(true);
  });

  it("supports a successful response with no body", async () => {
    await expect(personRead(person(async () => new Response(null, { status: 204 })), "/api/empty"))
      .resolves.toEqual({ status: 204, body: "" });
  });

  it("does not turn a successful HTTP response with broken bytes into permission evidence", async () => {
    const failure = new Error("fixture body read failed");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { status: 200 });
    await expect(personRead(person(async () => response), "/api/companies/owned-company")).rejects.toBe(failure);
  });

  it("preserves a genuine authenticated request failure", async () => {
    const failure = new Error("fixture request unavailable");
    await expect(personRead(person(async () => { throw failure; }), "/api/companies/owned-company")).rejects.toBe(failure);
  });
});
