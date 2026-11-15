import { describe, expect, it, vi } from "vitest";
import { prepareSlackEndpoints } from "./slack-endpoint-preparation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const endpoints = Array.from({ length: 5 }, (_, i) => ({ id: String(i), connectionId: `connection-${i}` }));

describe("Slack endpoint preparation batches", () => {
  it("does not start work without candidates", async () => {
    const resolve = vi.fn();
    expect(await prepareSlackEndpoints([], resolve)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps at most two checks active and preserves candidate order", async () => {
    const pending = endpoints.map(() => deferred<string[]>());
    const resolve = vi.fn((endpoint: typeof endpoints[number]) => pending[Number(endpoint.id)].promise);
    const prepared = prepareSlackEndpoints(endpoints, resolve);
    expect(resolve.mock.calls.map(([endpoint]) => endpoint.id)).toEqual(["0", "1"]);
    pending[1].resolve(["second"]);
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledTimes(2);
    pending[0].resolve(["first"]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(4));
    pending[3].resolve(["fourth"]);
    pending[2].resolve([]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(5));
    pending[4].resolve(["fifth"]);
    expect(await prepared).toEqual(["first", "second", "fourth", "fifth"]);
  });

  it("settles the active batch before rejecting and does not start later candidates", async () => {
    const gate = deferred<string[]>();
    const error = new Error("Endpoint unavailable");
    const resolve = vi.fn((endpoint: typeof endpoints[number]) => endpoint.id === "0" ? Promise.reject(error) : gate.promise);
    let finished = false;
    const prepared = prepareSlackEndpoints(endpoints, resolve);
    const checked = expect(prepared).rejects.toBe(error).finally(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
    gate.resolve([]);
    await checked;
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps candidate-order failure precedence even if the second fails first", async () => {
    const first = deferred<string[]>();
    const firstError = new Error("First candidate failed");
    const secondError = new Error("Second candidate failed");
    const resolve = vi.fn((endpoint: typeof endpoints[number]) => endpoint.id === "0" ? first.promise : Promise.reject(secondError));
    const checked = expect(prepareSlackEndpoints(endpoints, resolve)).rejects.toBe(firstError);
    await Promise.resolve();
    first.reject(firstError);
    await checked;
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("settles a sibling after a synchronous resolver failure", async () => {
    const gate = deferred<string[]>();
    const error = new Error("Synchronous failure");
    const resolve = vi.fn((endpoint: typeof endpoints[number]) => {
      if (endpoint.id === "0") throw error;
      return gate.promise;
    });
    const checked = expect(prepareSlackEndpoints(endpoints, resolve)).rejects.toBe(error);
    expect(resolve).toHaveBeenCalledTimes(2);
    gate.resolve([]);
    await checked;
  });
});
