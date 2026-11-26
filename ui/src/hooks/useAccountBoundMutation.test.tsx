// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider, onlineManager, type QueryClient, type UseMutationResult } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConnectivityStore, type ConnectivityStore } from "@/lib/connectivity";
import { createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";
import { classifySendFailure } from "@/lib/pending-send";
import { useAccountBoundMutation } from "./useAccountBoundMutation";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/api/auth", () => ({ authApi: { getSession: lookup } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let store: ConnectivityStore;
let current: UseMutationResult<string, Error, { id: string }>;
const send = vi.fn();
const success = vi.fn();
const failure = vi.fn();
let waitForTurn: (() => Promise<void>) | undefined;

function Harness({ target = "original" }: { target?: string }) {
  current = useAccountBoundMutation({
    meta: { replay: "idempotent" },
    mutationFn: async (input: { id: string }) => send(target, input),
    onSuccess: success,
    onError: failure,
    waitForTurn,
  });
  return null;
}

function render(target = "original") {
  act(() => root.render(<QueryClientProvider client={client}><Harness target={target} /></QueryClientProvider>));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  send.mockReset().mockResolvedValue("saved");
  success.mockReset();
  failure.mockReset();
  lookup.mockReset().mockReturnValue(new Promise(() => {}));
  waitForTurn = undefined;
  store = createConnectivityStore({ probe: async () => ({ reachable: true }), browserOnline: true });
  client = createAppQueryClient({ connectivity: store });
  client.setQueryData(queryKeys.auth.session, { user: { id: "account-a" } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  store.dispose();
  onlineManager.setOnline(true);
});

it.each(["accept", "reject", "answer"])("does not send a paused %s after account change", async (id) => {
  onlineManager.setOnline(false);
  render();
  let pending!: Promise<unknown>;
  act(() => { pending = current.mutateAsync({ id }).catch(error => error); });
  await act(async () => {});
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    await client.resetQueries({ queryKey: queryKeys.auth.session });
    client.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
  });
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(send).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});

it("checks the account after waiting behind another write", async () => {
  let release!: () => void;
  waitForTurn = () => new Promise<void>(resolve => { release = resolve; });
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "queued" }).catch(error => error); });
  await act(async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
    release();
  });
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(send).not.toHaveBeenCalled();
});

it("retains the original target when the mounted surface changes", async () => {
  onlineManager.setOnline(false);
  render("task-a");
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "interaction-a" }); });
  render("task-b");
  await act(async () => {
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
  });
  expect(await pending).toBe("saved");
  expect(send).toHaveBeenCalledExactlyOnceWith("task-a", { id: "interaction-a" });
});

it("does not apply an old response to the next account", async () => {
  let resolve!: (result: string) => void;
  send.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "in-flight" }).catch(error => error); });
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
    resolve("saved for account-a");
  });
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(success).not.toHaveBeenCalled();
});

it("keeps an action pending through the first session lookup", async () => {
  client.removeQueries({ queryKey: queryKeys.auth.session });
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "startup" }).catch(error => error); });
  expect(send).not.toHaveBeenCalled();
  render("another-task");
  await act(async () => { client.setQueryData(queryKeys.auth.session, { user: { id: "account-a" } }); });
  expect(await pending).toBe("saved");
  expect(send).toHaveBeenCalledExactlyOnceWith("original", { id: "startup" });
  expect(success).toHaveBeenCalledTimes(1);
});

it("keeps the result uncertain after an account round trip during an accepted POST", async () => {
  let accepted!: (result: string) => void;
  send.mockReturnValue(new Promise<string>(resolve => { accepted = resolve; }));
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "accepted" }).catch(error => error); });
  await act(async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "account-a" } });
    accepted("accepted by account-a");
  });
  const error = await pending;
  expect(error).toMatchObject({ name: "AbortError" });
  expect(classifySendFailure(error)).toBe("pending");
});

it("restarts a failed initial session lookup for waiting work", async () => {
  client.removeQueries({ queryKey: queryKeys.auth.session });
  const error = new ApiError("Session lookup failed", 500, { error: "session_lookup_failed" });
  lookup.mockRejectedValueOnce(error).mockResolvedValue({ user: { id: "account-a" } });
  await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: lookup, retry: false }).catch(() => {});
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "startup" }).catch(error => error); });
  let result: unknown;
  await act(async () => { result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still waiting"), 1500))]); });
  expect(result).toBe("saved");
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledExactlyOnceWith("original", { id: "startup" });
});

it("reports an exhausted session lookup instead of leaving the action pending", async () => {
  client.removeQueries({ queryKey: queryKeys.auth.session });
  const error = new ApiError("Session lookup failed", 500, { error: "session_lookup_failed" });
  lookup.mockRejectedValue(error);
  await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: lookup, retry: false }).catch(() => {});
  render();
  let pending!: Promise<unknown>;
  await act(async () => { pending = current.mutateAsync({ id: "startup" }).catch(error => error); });
  let result: unknown;
  await act(async () => { result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still waiting"), 2000))]); });
  expect(result).toBe(error);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(current.isPending).toBe(false);
});
