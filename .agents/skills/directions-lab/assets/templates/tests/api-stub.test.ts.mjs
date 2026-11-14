export default () => `// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installApiStub, registerApiRoute } from "./api-stub";
import { COMPANY } from "./fixtures";

describe("installApiStub", () => {
  const original = window.fetch;
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()?.();
    window.fetch = original;
  });

  it("answers /api/ from the fixtures and puts fetch back when restored", async () => {
    restores.push(installApiStub());
    expect(window.fetch).not.toBe(original);
    const companies = await (await window.fetch("/api/companies")).json();
    expect(companies).toEqual([COMPANY]);
    restores.pop()?.();
    expect(window.fetch).toBe(original);
  });

  it("serves a registered route and answers anything else under /api/ with an empty object", async () => {
    registerApiRoute((pathname) => (pathname === "/api/lab/ping" ? { pong: true } : undefined));
    restores.push(installApiStub());
    expect(await (await window.fetch("/api/lab/ping")).json()).toEqual({ pong: true });
    expect(await (await window.fetch("/api/lab/nothing", { method: "POST" })).json()).toEqual({});
  });

  it("keeps one stub across nested installs and restores on the last release", () => {
    const first = installApiStub();
    const stub = window.fetch;
    const second = installApiStub();
    restores.push(first, second);
    expect(window.fetch).toBe(stub);
    first();
    expect(window.fetch).toBe(stub);
    first();
    expect(window.fetch).toBe(stub);
    second();
    expect(window.fetch).toBe(original);
  });
});
`;
